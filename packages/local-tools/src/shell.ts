import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

import {
  PlinthwayError,
  type JsonValue,
  type ToolDescriptor,
  type ToolInvocationDescription,
  type ToolInvocationOptions,
  type ToolInvocationResult,
  type ToolProvider,
} from '@plinthway/shared';

import { WorkspacePathPolicy } from './path-policy.js';
import { terminateProcessTree } from './process-tree.js';

export function isIgnorableStdinError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'EOF';
}

type Arguments = Readonly<Record<string, JsonValue>>;

const SAFE_ENVIRONMENT_KEYS = [
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
] as const;

const SHELL_TOOL: ToolDescriptor = {
  name: 'shell.run',
  source: { kind: 'builtin', id: 'shell' },
  description: 'Run one approved command or program from the current workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 16_384 },
      program: { type: 'string', minLength: 1, maxLength: 8_192 },
      args: {
        type: 'array',
        maxItems: 256,
        items: { type: 'string', maxLength: 8_192 },
      },
      cwd: { type: 'string', minLength: 1 },
      stdin: { type: 'string', maxLength: 1_048_576 },
    },
    additionalProperties: false,
    oneOf: [{ required: ['command'] }, { required: ['program'] }],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  intrinsicAction: 'ask',
};

export interface ShellLimits {
  readonly maxCommandBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStdinBytes: number;
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
}

const DEFAULT_LIMITS: ShellLimits = Object.freeze({
  maxCommandBytes: 16 * 1024,
  maxOutputBytes: 512 * 1024,
  maxStdinBytes: 1024 * 1024,
  maxArguments: 256,
  maxArgumentBytes: 8 * 1024,
});

export interface ShellToolProviderOptions {
  readonly workspace: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly limits?: Partial<ShellLimits>;
}

function record(value: unknown): Arguments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be an object');
  }
  return value as Arguments;
}

function optionalString(input: Arguments, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', `${name} must be a string`);
  }
  return value;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PlinthwayError('CANCELLED', 'Shell execution was cancelled');
  }
}

function parseArguments(input: Arguments, limits: ShellLimits): readonly string[] {
  const value = input.args;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.maxArguments) {
    throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'args must be a bounded string array');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || Buffer.byteLength(entry) > limits.maxArgumentBytes) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Each argument must be a bounded string');
    }
    return entry;
  });
}

function sanitizedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  workspace: string,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) output[key] = value;
  }
  output.PLINTHWAY_WORKSPACE = workspace;
  return output;
}

interface CapturedOutput {
  readonly chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function capture(output: CapturedOutput, chunk: Buffer, limit: number): void {
  const remaining = limit - output.bytes;
  if (remaining > 0) {
    const selected = chunk.subarray(0, remaining);
    output.chunks.push(selected);
    output.bytes += selected.length;
  }
  if (chunk.length > remaining) output.truncated = true;
}

export class ShellToolProvider implements ToolProvider {
  readonly #paths: WorkspacePathPolicy;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #limits: ShellLimits;

  private constructor(
    paths: WorkspacePathPolicy,
    environment: NodeJS.ProcessEnv,
    limits: ShellLimits,
  ) {
    this.#paths = paths;
    this.#environment = environment;
    this.#limits = limits;
  }

  static async create(options: ShellToolProviderOptions): Promise<ShellToolProvider> {
    const paths = await WorkspacePathPolicy.create(options.workspace);
    return new ShellToolProvider(
      paths,
      sanitizedEnvironment(options.environment ?? process.env, paths.root),
      { ...DEFAULT_LIMITS, ...options.limits },
    );
  }

  listTools(): readonly ToolDescriptor[] {
    return [SHELL_TOOL];
  }

  async describeInvocation(
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ToolInvocationDescription> {
    if (toolName !== 'shell.run') {
      throw new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, { toolName });
    }
    const input = record(argumentsValue);
    const cwd = await this.#paths.resolve(optionalString(input, 'cwd') ?? '.');
    return {
      targets: [cwd.absolute],
      readOnlyHint: false,
      sideEffects:
        'runs a local process with your OS filesystem and network authority; it is not sandboxed',
      riskFloor: 'ask',
    };
  }

  async invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    if (toolName !== 'shell.run') {
      throw new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, { toolName });
    }
    abortIfNeeded(options.signal);
    const input = record(argumentsValue);
    const command = optionalString(input, 'command');
    const program = optionalString(input, 'program');
    if ((command === undefined) === (program === undefined)) {
      throw new PlinthwayError(
        'TOOL_ARGUMENTS_INVALID',
        'shell.run requires exactly one of command or program',
      );
    }
    if (
      command !== undefined &&
      (command.length === 0 || Buffer.byteLength(command) > this.#limits.maxCommandBytes)
    ) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'command is empty or exceeds its limit');
    }
    if (
      program !== undefined &&
      (program.length === 0 || Buffer.byteLength(program) > this.#limits.maxArgumentBytes)
    ) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'program is empty or exceeds its limit');
    }
    const args = parseArguments(input, this.#limits);
    if (command !== undefined && input.args !== undefined) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'args are only valid with program mode');
    }
    const stdin = optionalString(input, 'stdin');
    if (stdin !== undefined && Buffer.byteLength(stdin) > this.#limits.maxStdinBytes) {
      throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Shell stdin exceeds 1 MiB');
    }
    const cwd = await this.#paths.resolve(optionalString(input, 'cwd') ?? '.');
    if (!(await stat(cwd.absolute)).isDirectory()) {
      throw new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'Shell cwd must be a directory', {
        target: cwd.relative,
      });
    }
    abortIfNeeded(options.signal);
    return this.#execute(
      command ?? program ?? '',
      command === undefined ? args : [],
      command !== undefined,
      cwd.absolute,
      stdin,
      options,
    );
  }

  #execute(
    executable: string,
    args: readonly string[],
    useShell: boolean,
    cwd: string,
    stdin: string | undefined,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: this.#environment,
        shell: useShell,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: CapturedOutput = { chunks: [], bytes: 0, truncated: false };
      const stderr: CapturedOutput = { chunks: [], bytes: 0, truncated: false };
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let stopping: Promise<void> | undefined;
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: PlinthwayError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const stop = (kind: 'timeout' | 'cancelled'): void => {
        if (settled || timedOut || cancelled) return;
        timedOut = kind === 'timeout';
        cancelled = kind === 'cancelled';
        stopping = terminateProcessTree(child).catch(() => undefined);
      };
      const onAbort = (): void => {
        stop('cancelled');
      };
      const timeout = setTimeout(() => {
        stop('timeout');
      }, options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        capture(stdout, chunk, this.#limits.maxOutputBytes);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        capture(stderr, chunk, this.#limits.maxOutputBytes);
      });
      child.once('error', (error) => {
        fail(
          new PlinthwayError(
            'STORAGE_ERROR',
            'Shell process could not be started',
            {},
            { cause: error },
          ),
        );
      });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (isIgnorableStdinError(error)) return;
        fail(
          new PlinthwayError(
            'STORAGE_ERROR',
            'Shell stdin could not be written',
            {},
            { cause: error },
          ),
        );
        void terminateProcessTree(child).catch(() => undefined);
      });
      child.once('close', (code, signal) => {
        void (async () => {
          await stopping;
          if (settled) return;
          if (timedOut) {
            fail(new PlinthwayError('TIMEOUT', 'Shell execution timed out'));
            return;
          }
          if (cancelled) {
            fail(new PlinthwayError('CANCELLED', 'Shell execution was cancelled'));
            return;
          }
          settled = true;
          cleanup();
          const content: JsonValue = {
            exitCode: code,
            signal,
            stdout: Buffer.concat(stdout.chunks).toString('utf8'),
            stderr: Buffer.concat(stderr.chunks).toString('utf8'),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs: Date.now() - startedAt,
          };
          resolve({ trusted: false, toolName: 'shell.run', content, isError: code !== 0 });
        })().catch((error: unknown) => {
          fail(
            error instanceof PlinthwayError
              ? error
              : new PlinthwayError('STORAGE_ERROR', 'Shell cleanup failed', {}, { cause: error }),
          );
        });
      });
      child.stdin.end(stdin);
    });
  }
}
