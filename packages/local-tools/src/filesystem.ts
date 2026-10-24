import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  PlinthwayError,
  canonicalJson,
  type JsonValue,
  type ToolDescriptor,
  type ToolInvocationDescription,
  type ToolInvocationOptions,
  type ToolInvocationResult,
  type ToolProvider,
} from '@plinthway/shared';

import { DEFAULT_FILESYSTEM_LIMITS, FILESYSTEM_TOOLS, type FilesystemLimits } from './contracts.js';
import { WorkspacePathPolicy } from './path-policy.js';

type Arguments = Readonly<Record<string, JsonValue>>;
type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FilesystemToolProviderOptions {
  readonly workspace: string;
  readonly limits?: Partial<FilesystemLimits>;
  /** @internal Deterministic race hooks used by containment regression tests. */
  readonly testHooks?: {
    readonly afterPathResolution?: (operation: string, absolutePath: string) => Promise<void>;
    readonly beforeMoveCommit?: (source: string, destination: string) => Promise<void>;
  };
}

function record(value: unknown): Arguments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be an object');
  }
  return value as Arguments;
}

function invocationTarget(input: Arguments): string {
  for (const key of ['path', 'base', 'source'] as const) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '.';
}

function stringArgument(input: Arguments, name: string, fallback?: string): string {
  const value = input[name] ?? fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', `${name} must be a non-empty string`);
  }
  return value;
}

function booleanArgument(input: Arguments, name: string, fallback: boolean): boolean {
  const value = input[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', `${name} must be a boolean`);
  }
  return value;
}

function integerArgument(
  input: Arguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PlinthwayError(
      'TOOL_ARGUMENTS_INVALID',
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

function typeOfEntry(value: Awaited<ReturnType<typeof lstat>>): EntryType {
  if (value.isFile()) return 'file';
  if (value.isDirectory()) return 'directory';
  if (value.isSymbolicLink()) return 'symlink';
  return 'other';
}

function abortIfNeeded(options: ToolInvocationOptions): void {
  if (options.signal?.aborted === true) {
    throw new PlinthwayError('CANCELLED', 'Tool invocation was cancelled');
  }
}

function storageError(operation: string, target: string, error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  return new PlinthwayError(
    'STORAGE_ERROR',
    `${operation} failed for ${target}`,
    { operation, target },
    error instanceof Error ? { cause: error } : undefined,
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function success(toolName: string, content: JsonValue): ToolInvocationResult {
  return { trusted: false, toolName, content, isError: false };
}

function ensureResultBounded(value: JsonValue, limits: FilesystemLimits): void {
  if (Buffer.byteLength(canonicalJson(value)) > limits.maxResultBytes) {
    throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Filesystem tool result exceeds 1 MiB');
  }
}

function globExpression(pattern: string): RegExp {
  if (
    path.isAbsolute(pattern) ||
    pattern.split(/[\\/]/u).includes('..') ||
    pattern.includes('\0')
  ) {
    throw new PlinthwayError('TOOL_DENIED', 'Glob pattern must stay within the workspace', {
      pattern,
    });
  }
  const normalized = pattern.replaceAll('\\', '/');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? '';
    if (character === '*' && normalized[index + 1] === '*') {
      index += 1;
      if (normalized[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

interface WalkEntry {
  readonly absolute: string;
  readonly relative: string;
  readonly type: EntryType;
}

async function walk(
  paths: WorkspacePathPolicy,
  baseRelative: string,
  includeHidden: boolean,
  options: ToolInvocationOptions,
): Promise<readonly WalkEntry[]> {
  const output: WalkEntry[] = [];
  const visit = async (prefix: string): Promise<void> => {
    abortIfNeeded(options);
    const workspaceRelative =
      prefix.length === 0
        ? baseRelative
        : baseRelative === '.'
          ? prefix
          : `${baseRelative.replaceAll('\\', '/')}/${prefix}`;
    const directoryTarget = await paths.resolve(workspaceRelative);
    const opened = await paths.openDirectory(directoryTarget);
    let entries: Dirent[];
    try {
      entries = await readdir(opened.accessPath, { withFileTypes: true });
    } finally {
      await opened.handle.close();
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!includeHidden && isHiddenName(entry.name)) continue;
      const relativeFromBase = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const relative =
        baseRelative === '.'
          ? relativeFromBase
          : `${baseRelative.replaceAll('\\', '/')}/${relativeFromBase}`;
      const absolute = path.join(paths.root, relative);
      const type: EntryType = entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other';
      output.push({ absolute, relative, type });
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(relativeFromBase);
      }
    }
  };
  await visit('');
  return output;
}

export class FilesystemToolProvider implements ToolProvider {
  readonly #paths: WorkspacePathPolicy;
  readonly #limits: FilesystemLimits;
  readonly #testHooks: FilesystemToolProviderOptions['testHooks'];

  private constructor(
    paths: WorkspacePathPolicy,
    limits: FilesystemLimits,
    testHooks: FilesystemToolProviderOptions['testHooks'],
  ) {
    this.#paths = paths;
    this.#limits = limits;
    this.#testHooks = testHooks;
  }

  static async create(options: FilesystemToolProviderOptions): Promise<FilesystemToolProvider> {
    return new FilesystemToolProvider(
      await WorkspacePathPolicy.create(options.workspace),
      {
        ...DEFAULT_FILESYSTEM_LIMITS,
        ...options.limits,
      },
      options.testHooks,
    );
  }

  listTools(): readonly ToolDescriptor[] {
    return FILESYSTEM_TOOLS;
  }

  async describeInvocation(
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ToolInvocationDescription> {
    const input = record(argumentsValue);
    const descriptor = FILESYSTEM_TOOLS.find((candidate) => candidate.name === toolName);
    if (descriptor === undefined) {
      throw new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, { toolName });
    }
    const pathInputs =
      toolName === 'filesystem.move'
        ? [stringArgument(input, 'source'), stringArgument(input, 'destination')]
        : [
            stringArgument(
              input,
              toolName === 'filesystem.glob' || toolName === 'filesystem.search_text'
                ? 'base'
                : 'path',
              '.',
            ),
          ];
    const resolved = await Promise.all(
      pathInputs.map((target) =>
        this.#paths.resolve(target, {
          mustExist: ![
            'filesystem.write_text',
            'filesystem.create_directory',
            'filesystem.move',
          ].includes(toolName),
        }),
      ),
    );
    const readOnlyHint = descriptor.annotations?.readOnlyHint === true;
    const sensitive =
      resolved.some((target) => target.sensitive) ||
      (['filesystem.list', 'filesystem.glob', 'filesystem.search_text'].includes(toolName) &&
        booleanArgument(input, 'includeHidden', false)) ||
      toolName === 'filesystem.search_text';
    return {
      targets: resolved.map((target) => target.absolute),
      readOnlyHint,
      sideEffects: readOnlyHint
        ? sensitive
          ? 'may disclose sensitive workspace contents'
          : 'none anticipated'
        : toolName === 'filesystem.remove'
          ? 'deletes workspace data'
          : 'modifies workspace data',
      riskFloor: readOnlyHint ? (sensitive ? 'ask' : 'allow') : 'ask',
    };
  }

  async invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    abortIfNeeded(options);
    const input = record(argumentsValue);
    let content: JsonValue;
    try {
      if (toolName === 'filesystem.read_text') content = await this.#readText(input, options);
      else if (toolName === 'filesystem.list') content = await this.#list(input, options);
      else if (toolName === 'filesystem.stat') content = await this.#stat(input);
      else if (toolName === 'filesystem.write_text') content = await this.#writeText(input);
      else if (toolName === 'filesystem.create_directory')
        content = await this.#createDirectory(input);
      else if (toolName === 'filesystem.move') content = await this.#move(input);
      else if (toolName === 'filesystem.remove') content = await this.#remove(input);
      else if (toolName === 'filesystem.glob') content = await this.#glob(input, options);
      else if (toolName === 'filesystem.search_text') content = await this.#search(input, options);
      else {
        throw new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, {
          toolName,
        });
      }
    } catch (error) {
      throw storageError(toolName, invocationTarget(input), error);
    }
    ensureResultBounded(content, this.#limits);
    return success(toolName, content);
  }

  async #readText(input: Arguments, options: ToolInvocationOptions): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path'));
    await this.#testHooks?.afterPathResolution?.('read_text', target.absolute);
    const opened = await this.#paths.openFile(target);
    let bytes: Buffer;
    try {
      bytes = await opened.handle.readFile();
    } finally {
      await opened.handle.close();
    }
    abortIfNeeded(options);
    if (bytes.length > this.#limits.maxTextBytes) {
      throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Text file exceeds the read limit', {
        target: target.relative,
      });
    }
    if (bytes.includes(0)) {
      throw new PlinthwayError('CAPABILITY_UNSUPPORTED', 'Binary files are not supported', {
        target: target.relative,
      });
    }
    const lines = bytes.toString('utf8').split(/\r?\n/u);
    const startLine = integerArgument(input, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER);
    const maxLines = integerArgument(input, 'maxLines', 2000, 1, 5000);
    const start = startLine - 1;
    const selected = lines.slice(start, start + maxLines);
    return {
      path: target.relative,
      text: selected.join('\n'),
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
      truncated: start + selected.length < lines.length,
    };
  }

  async #list(input: Arguments, options: ToolInvocationOptions): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path', '.'));
    const includeHidden = booleanArgument(input, 'includeHidden', false);
    const limit = integerArgument(input, 'limit', this.#limits.maxListEntries, 1, 1000);
    const opened = await this.#paths.openDirectory(target);
    try {
      const entries = await readdir(opened.accessPath, { withFileTypes: true });
      const visible = entries
        .filter((entry) => includeHidden || !isHiddenName(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      const selected = visible.slice(0, limit);
      const normalized = await Promise.all(
        selected.map(async (entry) => {
          abortIfNeeded(options);
          const metadata = await lstat(path.join(opened.accessPath, entry.name));
          const relative =
            target.relative === '.' ? entry.name : path.join(target.relative, entry.name);
          return {
            name: entry.name,
            path: relative.replaceAll('\\', '/'),
            type: typeOfEntry(metadata),
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
          };
        }),
      );
      return {
        path: target.relative,
        entries: normalized,
        truncated: visible.length > selected.length,
      };
    } finally {
      await opened.handle.close();
    }
  }

  async #stat(input: Arguments): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path'), {
      followFinalSymlink: false,
    });
    const parent = await this.#paths.openParent(target);
    try {
      const metadata = await lstat(parent.targetPath);
      return {
        path: target.relative,
        type: typeOfEntry(metadata),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      };
    } finally {
      await parent.handle.close();
    }
  }

  async #writeText(input: Arguments): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path'), {
      mustExist: false,
      allowRoot: false,
      followFinalSymlink: false,
    });
    await this.#testHooks?.afterPathResolution?.('write_text', target.absolute);
    const content = input.content;
    const mode = input.mode;
    if (typeof content !== 'string' || (mode !== 'create' && mode !== 'overwrite')) {
      throw new PlinthwayError(
        'TOOL_ARGUMENTS_INVALID',
        'write_text requires string content and mode create or overwrite',
      );
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > this.#limits.maxTextBytes) {
      throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Text content exceeds the write limit');
    }
    const parent = await this.#paths.openParent(
      target,
      booleanArgument(input, 'createParents', false),
    );
    try {
      if (mode === 'create') {
        const handle = await open(parent.targetPath, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
      } else {
        const metadata = await lstat(parent.targetPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new PlinthwayError('TOOL_DENIED', 'Only regular files can be overwritten', {
            target: target.relative,
          });
        }
        const temporary = path.join(
          parent.accessPath,
          `.${path.basename(target.relative)}.${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, content, {
            encoding: 'utf8',
            mode: metadata.mode,
            flag: 'wx',
          });
          await chmod(temporary, metadata.mode);
          await rename(temporary, parent.targetPath);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
    } finally {
      await parent.handle.close();
    }
    return { path: target.relative, bytes, mode };
  }

  async #createDirectory(input: Arguments): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path'), {
      mustExist: false,
      allowRoot: false,
      followFinalSymlink: false,
    });
    const recursive = booleanArgument(input, 'recursive', true);
    const parent = await this.#paths.openParent(target, recursive);
    try {
      await mkdir(parent.targetPath);
    } catch (error) {
      if (recursive && errorCode(error) === 'EEXIST') {
        const metadata = await lstat(parent.targetPath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error;
      } else throw error;
    } finally {
      await parent.handle.close();
    }
    return { path: target.relative, created: true };
  }

  async #move(input: Arguments): Promise<JsonValue> {
    const source = await this.#paths.resolve(stringArgument(input, 'source'), {
      allowRoot: false,
      followFinalSymlink: false,
    });
    const destination = await this.#paths.resolve(stringArgument(input, 'destination'), {
      mustExist: false,
      allowRoot: false,
      followFinalSymlink: false,
    });
    const overwrite = booleanArgument(input, 'overwrite', false);
    const sourceCanonical = await realpath(source.absolute);
    const sourceIdentity = await stat(source.absolute);
    let destinationCanonical = destination.absolute;
    let destinationIdentity: Awaited<ReturnType<typeof stat>> | undefined;
    let destinationExists = true;
    try {
      destinationCanonical = await realpath(destination.absolute);
      destinationIdentity = await stat(destination.absolute);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
      destinationExists = false;
    }
    const overlaps = (left: string, right: string): boolean => {
      const relative = path.relative(left, right);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (
      overlaps(source.absolute, destination.absolute) ||
      overlaps(destination.absolute, source.absolute) ||
      overlaps(sourceCanonical, destinationCanonical) ||
      overlaps(destinationCanonical, sourceCanonical) ||
      (destinationIdentity !== undefined &&
        sourceIdentity.dev === destinationIdentity.dev &&
        sourceIdentity.ino === destinationIdentity.ino)
    ) {
      throw new PlinthwayError('TOOL_DENIED', 'Move source and destination must not overlap', {
        source: source.relative,
        destination: destination.relative,
      });
    }
    const sourceParent = await this.#paths.openParent(source);
    const destinationParent = await this.#paths.openParent(destination);
    try {
      try {
        await lstat(destinationParent.targetPath);
        destinationExists = true;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        destinationExists = false;
      }
      if (destinationExists && !overwrite) {
        throw new PlinthwayError('STORAGE_ERROR', 'Move destination already exists', {
          target: destination.relative,
        });
      }
      if (destinationExists) {
        const backup = path.join(
          destinationParent.accessPath,
          `.${path.basename(destination.relative)}.${randomUUID()}.move-backup`,
        );
        await rename(destinationParent.targetPath, backup);
        try {
          await this.#testHooks?.beforeMoveCommit?.(
            sourceParent.targetPath,
            destinationParent.targetPath,
          );
          await rename(sourceParent.targetPath, destinationParent.targetPath);
        } catch (error) {
          await rename(backup, destinationParent.targetPath).catch(() => undefined);
          throw error;
        }
        await rm(backup, { recursive: true });
      } else {
        await rename(sourceParent.targetPath, destinationParent.targetPath);
      }
    } finally {
      await Promise.all([sourceParent.handle.close(), destinationParent.handle.close()]);
    }
    return { source: source.relative, destination: destination.relative, overwritten: overwrite };
  }

  async #remove(input: Arguments): Promise<JsonValue> {
    const target = await this.#paths.resolve(stringArgument(input, 'path'), {
      allowRoot: false,
      followFinalSymlink: false,
    });
    const parent = await this.#paths.openParent(target);
    try {
      await rm(parent.targetPath, { recursive: booleanArgument(input, 'recursive', false) });
    } finally {
      await parent.handle.close();
    }
    return { path: target.relative, removed: true };
  }

  async #glob(input: Arguments, options: ToolInvocationOptions): Promise<JsonValue> {
    const pattern = globExpression(stringArgument(input, 'pattern'));
    const base = await this.#paths.resolve(stringArgument(input, 'base', '.'));
    await this.#testHooks?.afterPathResolution?.('glob', base.absolute);
    const includeHidden = booleanArgument(input, 'includeHidden', false);
    const limit = integerArgument(input, 'limit', this.#limits.maxListEntries, 1, 1000);
    const entries = await walk(this.#paths, base.relative, includeHidden, options);
    const matching = entries
      .filter((entry) =>
        pattern.test(path.relative(base.absolute, entry.absolute).replaceAll('\\', '/')),
      )
      .sort((left, right) => left.relative.localeCompare(right.relative));
    return {
      matches: matching
        .slice(0, limit)
        .map((entry) => ({ path: entry.relative, type: entry.type })),
      truncated: matching.length > limit,
    };
  }

  async #search(input: Arguments, options: ToolInvocationOptions): Promise<JsonValue> {
    const query = stringArgument(input, 'query');
    const base = await this.#paths.resolve(stringArgument(input, 'base', '.'));
    const include = globExpression(stringArgument(input, 'include', '**/*'));
    const includeHidden = booleanArgument(input, 'includeHidden', false);
    const caseSensitive = booleanArgument(input, 'caseSensitive', false);
    const limit = integerArgument(input, 'limit', this.#limits.maxSearchMatches, 1, 1000);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const entries = await walk(this.#paths, base.relative, includeHidden, options);
    const files = entries
      .filter(
        (entry) =>
          entry.type === 'file' &&
          include.test(path.relative(base.absolute, entry.absolute).replaceAll('\\', '/')),
      )
      .sort((left, right) => left.relative.localeCompare(right.relative));
    const matches: Array<Record<string, JsonValue>> = [];
    let scannedBytes = 0;
    let truncated = false;
    for (const file of files) {
      abortIfNeeded(options);
      const target = await this.#paths.resolve(file.relative);
      const opened = await this.#paths.openFile(target);
      const metadata = await opened.handle.stat();
      if (scannedBytes + metadata.size > this.#limits.maxSearchBytes) {
        await opened.handle.close();
        scannedBytes = this.#limits.maxSearchBytes;
        truncated = true;
        break;
      }
      let bytes: Buffer;
      try {
        bytes = await opened.handle.readFile();
      } finally {
        await opened.handle.close();
      }
      scannedBytes += bytes.length;
      if (bytes.includes(0)) continue;
      const lines = bytes.toString('utf8').split(/\r?\n/u);
      for (const [index, line] of lines.entries()) {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column === -1) continue;
        matches.push({
          path: file.relative,
          line: index + 1,
          column: column + 1,
          text: line.slice(0, 4096),
        });
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (matches.length >= limit) break;
    }
    return { matches, truncated, scannedBytes };
  }
}
