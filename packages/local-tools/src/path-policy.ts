import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { PlinthwayError } from '@plinthway/shared';

export interface WorkspacePath {
  readonly absolute: string;
  readonly relative: string;
  readonly hidden: boolean;
  readonly sensitive: boolean;
}

export interface OpenedWorkspacePath {
  readonly handle: FileHandle;
  readonly accessPath: string;
}

export interface OpenedWorkspaceParent extends OpenedWorkspacePath {
  readonly targetPath: string;
}

export interface ResolveWorkspacePathOptions {
  readonly mustExist?: boolean;
  readonly allowRoot?: boolean;
  readonly followFinalSymlink?: boolean;
}

const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_BASENAMES = new Set([
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets',
]);
const SENSITIVE_EXTENSIONS = new Set(['.key', '.p12', '.pem', '.pfx']);

function pathSegments(value: string): readonly string[] {
  return value.replaceAll('\\', '/').split('/').filter(Boolean);
}

function isHiddenWorkspacePath(value: string): boolean {
  return pathSegments(value).some(
    (segment) => segment.startsWith('.') && segment !== '.' && segment !== '..',
  );
}

export function isSensitiveWorkspacePath(value: string): boolean {
  const segments = pathSegments(value);
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  if (SAFE_ENV_EXAMPLES.has(basename)) {
    return segments.slice(0, -1).some((segment) => segment.startsWith('.'));
  }
  if (segments.some((segment) => segment.startsWith('.'))) return true;
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(basename));
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function denied(message: string, target: string): PlinthwayError {
  return new PlinthwayError('TOOL_DENIED', message, { target });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function nearestExisting(candidate: string): Promise<string> {
  try {
    await lstat(candidate);
    return candidate;
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return nearestExisting(parent);
  }
}

export class WorkspacePathPolicy {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(workspace: string): Promise<WorkspacePathPolicy> {
    return new WorkspacePathPolicy(await realpath(path.resolve(workspace)));
  }

  async resolve(input: string, options: ResolveWorkspacePathOptions = {}): Promise<WorkspacePath> {
    if (input.length === 0 || input.includes('\0')) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Workspace path is invalid', {
        target: input,
      });
    }
    const lexical = path.resolve(this.root, input);
    if (!isContained(this.root, lexical)) {
      throw denied('Path is outside the workspace', input);
    }
    if (options.allowRoot === false && lexical === this.root) {
      throw denied('The workspace root cannot be modified', input);
    }

    const mustExist = options.mustExist !== false;
    const followFinalSymlink = options.followFinalSymlink !== false;
    let absolute = lexical;
    if (mustExist) {
      if (followFinalSymlink) absolute = await realpath(lexical);
      else await lstat(lexical);
      const checked = followFinalSymlink ? absolute : await realpath(path.dirname(lexical));
      if (!isContained(this.root, checked)) {
        throw denied('Path resolves outside the workspace', input);
      }
    } else {
      const ancestor = await nearestExisting(lexical);
      const resolvedAncestor = await realpath(ancestor);
      if (!isContained(this.root, resolvedAncestor)) {
        throw denied('Path resolves outside the workspace', input);
      }
      if (ancestor === lexical && followFinalSymlink) absolute = resolvedAncestor;
    }

    if (!isContained(this.root, absolute)) {
      throw denied('Path resolves outside the workspace', input);
    }
    const relative = path.relative(this.root, lexical) || '.';
    const resolvedRelative = path.relative(this.root, absolute) || '.';
    return {
      absolute,
      relative,
      hidden: isHiddenWorkspacePath(relative),
      sensitive: isSensitiveWorkspacePath(relative) || isSensitiveWorkspacePath(resolvedRelative),
    };
  }

  async openFile(target: WorkspacePath): Promise<OpenedWorkspacePath> {
    let handle: FileHandle;
    try {
      handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ELOOP') {
        throw denied('Path changed to a symbolic link during access', target.relative);
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw denied('Only regular files can be read', target.relative);
      }
      return { handle, accessPath: await this.#validateHandle(handle, target.relative) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async openDirectory(target: WorkspacePath): Promise<OpenedWorkspacePath> {
    let handle: FileHandle;
    try {
      handle = await open(
        target.absolute,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (errorCode(error) === 'ELOOP') {
        throw denied('Path changed to a symbolic link during access', target.relative);
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isDirectory()) {
        throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Path must be a directory', {
          target: target.relative,
        });
      }
      return { handle, accessPath: await this.#validateHandle(handle, target.relative) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async openParent(target: WorkspacePath, createParents = false): Promise<OpenedWorkspaceParent> {
    const parentRelative = path.dirname(target.relative);
    if (!createParents || parentRelative === '.') {
      const parent = await this.resolve(parentRelative);
      const opened = await this.openDirectory(parent);
      return {
        ...opened,
        targetPath: path.join(opened.accessPath, path.basename(target.relative)),
      };
    }

    let current = await this.openDirectory(await this.resolve('.'));
    let accumulated = '';
    try {
      for (const segment of pathSegments(parentRelative)) {
        const childPath = path.join(current.accessPath, segment);
        try {
          await mkdir(childPath);
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        accumulated = accumulated.length === 0 ? segment : path.join(accumulated, segment);
        const next = await this.openDirectory({
          absolute: childPath,
          relative: accumulated,
          hidden: isHiddenWorkspacePath(accumulated),
          sensitive: isSensitiveWorkspacePath(accumulated),
        });
        await current.handle.close();
        current = next;
      }
      return {
        ...current,
        targetPath: path.join(current.accessPath, path.basename(target.relative)),
      };
    } catch (error) {
      await current.handle.close();
      throw error;
    }
  }

  async #validateHandle(handle: FileHandle, target: string): Promise<string> {
    if (process.platform === 'linux') {
      const descriptorPath = `/proc/self/fd/${String(handle.fd)}`;
      try {
        const openedPath = await realpath(descriptorPath);
        if (!isContained(this.root, openedPath)) {
          throw denied('Opened path is outside the workspace', target);
        }
        return descriptorPath;
      } catch (error) {
        if (error instanceof PlinthwayError || errorCode(error) !== 'ENOENT') throw error;
      }
    }

    const [opened, current, canonical] = await Promise.all([
      handle.stat(),
      stat(path.resolve(this.root, target)),
      realpath(path.resolve(this.root, target)),
    ]);
    if (
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      !isContained(this.root, canonical)
    ) {
      throw denied('Path changed during access', target);
    }
    return canonical;
  }
}
