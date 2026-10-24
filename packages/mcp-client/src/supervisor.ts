import { PlinthwayError, type PublicMcpServerConfig } from '@plinthway/shared';

import type {
  McpConnectionPort,
  McpConnectionState,
  ConnectMcpServerOptions,
  McpConnector,
  McpServerStatus,
} from './contracts.js';

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

interface ServerEntry {
  readonly config: PublicMcpServerConfig;
  state: McpConnectionState;
  attempts: number;
  connection?: McpConnectionPort | undefined;
  lastError?: McpServerStatus['lastError'] | undefined;
  retryAt?: string | undefined;
  retryTimer?: ReturnType<typeof setTimeout> | undefined;
  unsubscribe?: (() => void) | undefined;
  inFlight?: boolean | undefined;
}

interface QueuedAttempt {
  readonly entry: ServerEntry;
  readonly complete: () => void;
}

export interface McpSupervisorOptions {
  readonly connect: McpConnector;
  readonly maxConcurrent?: number;
  readonly activationTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly random?: () => number;
}

export interface PrepareGenerationOptions {
  readonly connectionOptions?: (
    config: PublicMcpServerConfig,
  ) => ConnectMcpServerOptions | undefined;
  readonly onConnection?: (
    connection: McpConnectionPort,
    generationId: number,
  ) => void | Promise<void>;
  readonly onDisconnection?: (
    connection: McpConnectionPort,
    generationId: number,
  ) => void | Promise<void>;
}

interface ClassifiedError {
  readonly state: Extract<
    McpConnectionState,
    'auth-required' | 'reconnecting' | 'degraded' | 'incompatible'
  >;
  readonly retryable: boolean;
  readonly status: NonNullable<McpServerStatus['lastError']>;
}

function classifyError(error: unknown): ClassifiedError {
  const code = error instanceof PlinthwayError ? error.code : 'MCP_CONNECTION_FAILED';
  const message = error instanceof Error ? error.message : 'MCP connection failed';
  if (code === 'AUTH_FAILED' || code === 'CREDENTIAL_MISSING') {
    return {
      state: 'auth-required',
      retryable: false,
      status: { code, message, retryable: false },
    };
  }
  if (
    code === 'CONFIG_INVALID' ||
    code === 'MCP_PROTOCOL_ERROR' ||
    code === 'CAPABILITY_UNSUPPORTED'
  ) {
    return {
      state: 'incompatible',
      retryable: false,
      status: { code, message, retryable: false },
    };
  }
  if (code === 'MCP_CONNECTION_FAILED' || code === 'TIMEOUT' || code === 'RATE_LIMITED') {
    return {
      state: 'reconnecting',
      retryable: true,
      status: { code, message, retryable: true },
    };
  }
  return {
    state: 'degraded',
    retryable: false,
    status: { code, message, retryable: false },
  };
}

function timeoutError(serverId: string): PlinthwayError {
  return new PlinthwayError('TIMEOUT', `MCP server ${serverId} connection attempt timed out`, {
    serverId,
  });
}

let nextGenerationId = 1;

export class McpSupervisedGeneration {
  readonly id: number;
  readonly #connect: McpConnector;
  readonly #maxConcurrent: number;
  readonly #activationTimeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #random: () => number;
  readonly #onConnection: PrepareGenerationOptions['onConnection'];
  readonly #onDisconnection: PrepareGenerationOptions['onDisconnection'];
  readonly #connectionOptions: PrepareGenerationOptions['connectionOptions'];
  readonly #entries: ServerEntry[];
  readonly #queue: QueuedAttempt[] = [];
  #running = 0;
  #closed = false;

  constructor(
    servers: readonly PublicMcpServerConfig[],
    options: Required<
      Pick<
        McpSupervisorOptions,
        | 'connect'
        | 'maxConcurrent'
        | 'activationTimeoutMs'
        | 'retryBaseMs'
        | 'retryMaxMs'
        | 'random'
      >
    > &
      PrepareGenerationOptions,
  ) {
    this.id = nextGenerationId++;
    this.#connect = options.connect;
    this.#maxConcurrent = options.maxConcurrent;
    this.#activationTimeoutMs = options.activationTimeoutMs;
    this.#retryBaseMs = options.retryBaseMs;
    this.#retryMaxMs = options.retryMaxMs;
    this.#random = options.random;
    this.#onConnection = options.onConnection;
    this.#onDisconnection = options.onDisconnection;
    this.#connectionOptions = options.connectionOptions;
    this.#entries = servers.map((config) => ({
      config,
      state: 'connecting',
      attempts: 0,
    }));
  }

  get connections(): readonly McpConnectionPort[] {
    return this.#entries
      .flatMap((entry) => (entry.connection === undefined ? [] : [entry.connection]))
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  async activate(): Promise<void> {
    const initial = this.#entries.map(
      (entry) =>
        new Promise<void>((resolve) => {
          this.#queue.push({ entry, complete: resolve });
        }),
    );
    this.#drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(initial),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#activationTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  #drain(): void {
    while (!this.#closed && this.#running < this.#maxConcurrent) {
      const queued = this.#queue.shift();
      if (queued === undefined) return;
      this.#running += 1;
      void this.#attempt(queued.entry).finally(() => {
        this.#running -= 1;
        queued.complete();
        this.#drain();
      });
    }
  }

  async #connectWithTimeout(entry: ServerEntry): Promise<McpConnectionPort> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.#connect(entry.config, this.#connectionOptions?.(entry.config));
    void pending.then(
      async (connection) => {
        if (expired || this.#closed) await connection.close().catch(() => undefined);
      },
      () => undefined,
    );
    try {
      return await Promise.race([
        pending,
        new Promise<McpConnectionPort>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(timeoutError(entry.config.id));
          }, this.#activationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #attempt(entry: ServerEntry): Promise<void> {
    if (this.#closed || entry.connection !== undefined || entry.inFlight === true) return;
    entry.inFlight = true;
    entry.attempts += 1;
    entry.state = entry.attempts === 1 ? 'connecting' : 'reconnecting';
    entry.retryAt = undefined;
    let candidate: McpConnectionPort | undefined;
    let candidateUnsubscribe: (() => void) | undefined;
    const lifecycle = { disconnectedDuringSetup: false };
    try {
      const connection = await this.#connectWithTimeout(entry);
      candidate = connection;
      if (this.#isClosed()) {
        await connection.close().catch(() => undefined);
        return;
      }
      candidateUnsubscribe = connection.onStateChange?.((state) => {
        if (state !== 'degraded' && state !== 'closed') return;
        if (entry.connection === connection) this.#connectionLost(entry, connection);
        else lifecycle.disconnectedDuringSetup = true;
      });
      await this.#onConnection?.(connection, this.id);
      if (this.#isClosed()) {
        candidateUnsubscribe?.();
        await connection.close().catch(() => undefined);
        return;
      }
      if (
        lifecycle.disconnectedDuringSetup ||
        connection.state === 'degraded' ||
        connection.state === 'closed'
      ) {
        candidateUnsubscribe?.();
        await this.#onDisconnection?.(connection, this.id);
        throw new PlinthwayError(
          'MCP_CONNECTION_FAILED',
          `MCP server ${entry.config.id} disconnected during activation`,
          { serverId: entry.config.id },
        );
      }
      entry.connection = connection;
      entry.state = 'ready';
      entry.lastError = undefined;
      entry.retryAt = undefined;
      entry.unsubscribe = candidateUnsubscribe;
    } catch (error) {
      candidateUnsubscribe?.();
      await candidate?.close().catch(() => undefined);
      if (this.#isClosed()) return;
      const classified = classifyError(error);
      entry.state = classified.state;
      entry.lastError = classified.status;
      if (classified.retryable) this.#scheduleRetry(entry);
    } finally {
      entry.inFlight = false;
    }
  }

  #connectionLost(entry: ServerEntry, connection: McpConnectionPort): void {
    if (this.#closed || entry.connection !== connection) return;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    entry.connection = undefined;
    entry.state = 'reconnecting';
    entry.lastError = {
      code: 'MCP_CONNECTION_FAILED',
      message: `MCP server ${entry.config.id} connection closed`,
      retryable: true,
    };
    void this.#onDisconnection?.(connection, this.id);
    void connection.close().catch(() => undefined);
    this.#scheduleRetry(entry);
  }

  #scheduleRetry(entry: ServerEntry): void {
    const exponential = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** Math.min(entry.attempts - 1, 16),
    );
    const delay = Math.max(
      this.#retryBaseMs,
      Math.min(this.#retryMaxMs, Math.round(exponential * (0.5 + this.#random()))),
    );
    entry.retryAt = new Date(Date.now() + delay).toISOString();
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.#closed || entry.connection !== undefined) return;
      this.#queue.push({ entry, complete: () => undefined });
      this.#drain();
    }, delay);
  }

  status(): readonly McpServerStatus[] {
    return this.#entries
      .map((entry): McpServerStatus => {
        const state = entry.connection?.state ?? entry.state;
        const auth = entry.config.transport === 'streamable-http' ? entry.config.auth : undefined;
        const authorization: NonNullable<McpServerStatus['authorization']> =
          state === 'auth-required'
            ? {
                state: 'required',
                ...(entry.lastError?.message === undefined
                  ? {}
                  : { reason: entry.lastError.message }),
              }
            : auth === undefined || auth.mode === 'none'
              ? { state: 'not-required' }
              : {
                  state: 'authorized',
                  scopes: 'scopes' in auth ? [...auth.scopes] : [],
                };
        const deprecationWarnings = [
          ...(entry.connection?.discovery?.capabilities.logging === undefined
            ? []
            : ['MCP logging is deprecated in protocol revision 2026-07-28']),
          ...(entry.config.transport === 'streamable-http' &&
          entry.config.auth?.mode === 'oauth' &&
          entry.config.auth.clientId === undefined &&
          entry.config.auth.clientIdMetadataDocument === undefined
            ? ['OAuth dynamic client registration is deprecated; configure a client ID']
            : []),
        ];
        return {
          serverId: entry.config.id,
          state,
          authorization,
          ...(entry.connection?.discovery?.protocol === undefined
            ? {}
            : { protocol: entry.connection.discovery.protocol }),
          ...(entry.connection?.discovery?.serverInfo === undefined
            ? {}
            : { serverInfo: entry.connection.discovery.serverInfo }),
          ...(entry.connection?.discovery?.capabilities === undefined
            ? {}
            : { capabilities: entry.connection.discovery.capabilities }),
          ...(entry.connection?.discovery?.extensions === undefined
            ? {}
            : { extensions: entry.connection.discovery.extensions }),
          ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
          ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
          ...(deprecationWarnings.length === 0 ? {} : { deprecationWarnings }),
        };
      })
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
  }

  reconnect(serverId: string): Promise<void> {
    const entry = this.#entries.find((candidate) => candidate.config.id === serverId);
    if (entry === undefined || this.#closed) return Promise.resolve();
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.retryAt = undefined;
    entry.lastError = undefined;
    const connection = entry.connection;
    if (connection !== undefined) {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      entry.connection = undefined;
      void this.#onDisconnection?.(connection, this.id);
      void connection.close().catch(() => undefined);
    }
    entry.state = 'reconnecting';
    const completed = new Promise<void>((resolve) => {
      this.#queue.push({ entry, complete: resolve });
    });
    this.#drain();
    return completed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.splice(0).forEach(({ complete }) => {
      complete();
    });
    for (const entry of this.#entries) {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
      entry.retryAt = undefined;
      entry.state = 'closed';
    }
    await Promise.allSettled(this.connections.map(async (connection) => connection.close()));
  }
}

export class McpSupervisor {
  readonly #options: Required<McpSupervisorOptions>;

  constructor(options: McpSupervisorOptions) {
    this.#options = {
      connect: options.connect,
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      activationTimeoutMs: options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      retryMaxMs: options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      random: options.random ?? Math.random,
    };
    if (this.#options.maxConcurrent < 1) {
      throw new RangeError('MCP maxConcurrent must be at least one');
    }
  }

  async prepare(
    servers: readonly PublicMcpServerConfig[],
    options: PrepareGenerationOptions = {},
  ): Promise<McpSupervisedGeneration> {
    const generation = new McpSupervisedGeneration(servers, { ...this.#options, ...options });
    await generation.activate();
    return generation;
  }
}
