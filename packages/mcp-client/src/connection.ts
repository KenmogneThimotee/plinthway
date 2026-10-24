import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';

import {
  Client,
  type ClientOptions,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTaskSessionFromClient } from '@modelcontextprotocol/ext-tasks/client';
import { MCP_APP_RESOURCE_MIME_TYPE } from '@plinthway/mcp-app-host';

import {
  canonicalJson,
  PlinthwayError,
  sha256,
  type JsonValue,
  type PublicMcpServerConfig,
} from '@plinthway/shared';

import type {
  ConnectMcpServerOptions,
  McpCallOptions,
  McpConnectionPort,
  McpHostEvent,
  McpIcon,
  McpLoggingLevel,
  McpServerDiscovery,
  McpToolAnnotations,
  NativeMcpCompletionResult,
  NativeMcpPrompt,
  NativeMcpPromptResult,
  NativeMcpResource,
  NativeMcpResourceResult,
  NativeMcpResourceTemplate,
  NativeMcpResult,
  NativeMcpTool,
  McpTaskExecution,
  McpTaskReference,
  McpTaskView,
} from './contracts.js';
import type { McpInteractionBrokerPort } from './interaction-broker.js';
import { assertAllowedMcpUrl, createRestrictedFetch } from './network-policy.js';
import { McpTaskAdapter } from './task-adapter.js';
import { TaskMultiplexTransport } from './task-transport.js';
import {
  McpSkillsProtocol,
  decodeSkillResourceResult,
  type McpSkillProtocolRequest,
} from './skills-protocol.js';
import type { McpSkill, McpSkillDirectoryEntry, McpSkillFile } from './skills.js';

const CLIENT_INFO = { name: 'plinthway', version: '0.1.0' } as const;

const PLATFORM_ENVIRONMENT =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];

export function mcpClientOptions(
  options: Pick<
    ConnectMcpServerOptions,
    'responseCacheStore' | 'cachePartition' | 'interactionBroker' | 'protocolProbeTimeoutMs'
  > = {},
  onListChanged?: (
    catalog: Extract<McpHostEvent, { readonly type: 'catalog-changed' }>['catalog'],
    error: Error | null,
  ) => void,
  extensions: {
    readonly tasks?: boolean;
    readonly skills?: boolean;
    readonly apps?: boolean;
    readonly oauthClientCredentials?: boolean;
    readonly enterpriseManagedAuth?: boolean;
  } = {},
): ClientOptions {
  const capabilities = {
    ...(options.interactionBroker === undefined
      ? {}
      : {
          roots: { listChanged: false },
          ...(options.interactionBroker.supportsSampling === true ? { sampling: {} } : {}),
          elicitation: { form: {}, url: {} },
        }),
    ...(extensions.tasks === true ||
    extensions.skills === true ||
    extensions.apps === true ||
    extensions.oauthClientCredentials === true ||
    extensions.enterpriseManagedAuth === true
      ? {
          extensions: {
            ...(extensions.tasks === true ? { 'io.modelcontextprotocol/tasks': {} } : {}),
            ...(extensions.skills === true ? { 'io.modelcontextprotocol/skills': {} } : {}),
            ...(extensions.apps === true
              ? { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] } }
              : {}),
            ...(extensions.oauthClientCredentials === true
              ? { 'io.modelcontextprotocol/oauth-client-credentials': {} }
              : {}),
            ...(extensions.enterpriseManagedAuth === true
              ? { 'io.modelcontextprotocol/enterprise-managed-authorization': {} }
              : {}),
          },
        }
      : {}),
  };
  return {
    versionNegotiation: {
      mode: 'auto',
      probe: { timeoutMs: options.protocolProbeTimeoutMs ?? 2_000, maxRetries: 0 },
    },
    listMaxPages: 64,
    inputRequired: { autoFulfill: true, maxRounds: 8 },
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    ...(onListChanged === undefined
      ? {}
      : {
          listChanged: {
            tools: {
              autoRefresh: false,
              onChanged: (error: Error | null) => {
                onListChanged('tools', error);
              },
            },
            prompts: {
              autoRefresh: false,
              onChanged: (error: Error | null) => {
                onListChanged('prompts', error);
              },
            },
            resources: {
              autoRefresh: false,
              onChanged: (error: Error | null) => {
                onListChanged('resources', error);
              },
            },
          },
        }),
    ...(options.responseCacheStore === undefined
      ? {}
      : { responseCacheStore: options.responseCacheStore }),
    ...(options.cachePartition === undefined ? {} : { cachePartition: options.cachePartition }),
  };
}

function normalizeIcon(icon: {
  readonly src: string;
  readonly mimeType?: string | undefined;
  readonly sizes?: readonly string[] | undefined;
  readonly theme?: 'light' | 'dark' | undefined;
}): McpIcon {
  return {
    src: icon.src,
    ...(icon.mimeType === undefined ? {} : { mimeType: icon.mimeType }),
    ...(icon.sizes === undefined ? {} : { sizes: [...icon.sizes] }),
    ...(icon.theme === undefined ? {} : { theme: icon.theme }),
  };
}

function normalizeAnnotations(annotations: {
  readonly title?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}): McpToolAnnotations {
  return {
    ...(annotations.title === undefined ? {} : { title: annotations.title }),
    ...(annotations.readOnlyHint === undefined ? {} : { readOnlyHint: annotations.readOnlyHint }),
    ...(annotations.destructiveHint === undefined
      ? {}
      : { destructiveHint: annotations.destructiveHint }),
    ...(annotations.idempotentHint === undefined
      ? {}
      : { idempotentHint: annotations.idempotentHint }),
    ...(annotations.openWorldHint === undefined
      ? {}
      : { openWorldHint: annotations.openWorldHint }),
  };
}

function hasNumberMcpHeader(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasNumberMcpHeader);
  const record = value as Readonly<Record<string, unknown>>;
  if ('x-mcp-header' in record && record.type === 'number') return true;
  return Object.values(record).some(hasNumberMcpHeader);
}

function normalizedJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function normalizeMetadata<T extends object>(
  value: T & { readonly _meta?: Readonly<Record<string, unknown>> | undefined },
): Omit<T, '_meta'> & { readonly meta?: Readonly<Record<string, JsonValue>> } {
  const { _meta, ...rest } = value;
  return {
    ...(normalizedJson(rest) as Omit<T, '_meta'>),
    ...(_meta === undefined
      ? {}
      : { meta: normalizedJson(_meta) as Readonly<Record<string, JsonValue>> }),
  };
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

export function validateStdioConfig(
  config: Extract<PublicMcpServerConfig, { transport: 'stdio' }>,
): void {
  const values = [
    config.command,
    ...config.args,
    ...(config.cwd === undefined ? [] : [config.cwd]),
    ...config.env,
  ];
  if (values.some(hasNul)) {
    throw new PlinthwayError(
      'MCP_CONNECTION_FAILED',
      'MCP stdio configuration contains a NUL byte',
      {
        serverId: config.id,
      },
    );
  }
}

export function minimalEnvironment(
  allowlist: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of new Set([...PLATFORM_ENVIRONMENT, ...allowlist])) {
    const value = source[name];
    if (value !== undefined && !hasNul(value)) result[name] = value;
  }
  return result;
}

async function resolveExecutable(
  command: string,
  cwd: string | undefined,
  env: Record<string, string>,
): Promise<string> {
  const baseCandidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command)]
      : (env.PATH ?? '')
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => resolve(entry, command));
  const candidates =
    process.platform === 'win32' && extname(command).length === 0
      ? baseCandidates.flatMap((candidate) => [`${candidate}.exe`, `${candidate}.com`])
      : baseCandidates;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the explicit PATH.
    }
  }
  throw new PlinthwayError(
    'MCP_CONNECTION_FAILED',
    `MCP executable could not be resolved: ${command}`,
  );
}

export function mapConnectionError(serverId: string, error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  if (
    UnauthorizedError.isInstance(error) ||
    (error instanceof SdkError &&
      (error.code === SdkErrorCode.ClientHttpAuthentication ||
        error.code === SdkErrorCode.ClientHttpForbidden))
  ) {
    return new PlinthwayError(
      'AUTH_FAILED',
      `MCP server ${serverId} requires authorization`,
      { serverId },
      { cause: error },
    );
  }
  if (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.InvalidResult ||
      error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.ListPaginationExceeded)
  ) {
    return new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP server ${serverId} is incompatible`,
      { serverId },
      { cause: error },
    );
  }
  return new PlinthwayError(
    'MCP_CONNECTION_FAILED',
    `Failed to connect to MCP server ${serverId}`,
    { serverId },
    error instanceof Error ? { cause: error } : undefined,
  );
}

function mapCallError(
  serverId: string,
  toolName: string,
  error: unknown,
  signal?: AbortSignal,
): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
    return new PlinthwayError('CANCELLED', `MCP tool ${serverId}.${toolName} was cancelled`, {
      serverId,
      toolName,
    });
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new PlinthwayError('TIMEOUT', `MCP tool ${serverId}.${toolName} timed out`, {
      serverId,
      toolName,
    });
  }
  return new PlinthwayError(
    'MCP_PROTOCOL_ERROR',
    `MCP tool ${serverId}.${toolName} failed`,
    { serverId, toolName },
    error instanceof Error ? { cause: error } : undefined,
  );
}

export class McpConnection implements McpConnectionPort {
  #state: McpConnectionPort['state'] = 'connecting';
  readonly #stateListeners = new Set<(state: McpConnectionPort['state']) => void>();
  readonly #eventListeners = new Set<(event: McpHostEvent) => void>();
  readonly serverId: string;
  discovery: McpServerDiscovery | undefined;
  readonly #client: Client;
  readonly #httpTransport: StreamableHTTPClientTransport | undefined;
  readonly #taskTransport: TaskMultiplexTransport | undefined;
  readonly #interactionBroker: McpInteractionBrokerPort | undefined;
  readonly #clientCapabilities: Readonly<Record<string, JsonValue>>;
  readonly #endpointId: string;
  readonly #toolDeclarations = new Map<string, NativeMcpTool>();
  #tasks: McpTaskAdapter | undefined;
  #skills: McpSkillsProtocol | undefined;
  #appsEnabled = false;
  #closing = false;

  constructor(
    serverId: string,
    client: Client,
    httpTransport?: StreamableHTTPClientTransport,
    interactionBroker?: McpInteractionBrokerPort,
    taskTransport?: TaskMultiplexTransport,
    clientCapabilities: Readonly<Record<string, JsonValue>> = {},
    endpointId = `mcp:${serverId}`,
  ) {
    this.serverId = serverId;
    this.#client = client;
    this.#httpTransport = httpTransport;
    this.#taskTransport = taskTransport;
    this.#interactionBroker = interactionBroker;
    this.#clientCapabilities = clientCapabilities;
    this.#endpointId = endpointId;
    this.#client.onclose = () => {
      this.state = this.#closing ? 'closed' : 'degraded';
    };
    this.#client.onerror = () => {
      if (!this.#closing) this.state = 'degraded';
    };
    this.#client.setNotificationHandler('notifications/resources/updated', (notification) => {
      this.#emit({
        type: 'resource-updated',
        serverId: this.serverId,
        uri: notification.params.uri,
      });
    });
    this.#client.setNotificationHandler('notifications/progress', (notification) => {
      this.#emit({
        type: 'progress',
        serverId: this.serverId,
        progressToken: notification.params.progressToken,
        progress: notification.params.progress,
        ...(notification.params.total === undefined ? {} : { total: notification.params.total }),
        ...(notification.params.message === undefined
          ? {}
          : { message: notification.params.message }),
      });
    });
    this.#client.setNotificationHandler('notifications/message', (notification) => {
      this.#emit({
        type: 'logging',
        serverId: this.serverId,
        level: notification.params.level,
        ...(notification.params.logger === undefined ? {} : { logger: notification.params.logger }),
        data: normalizedJson(notification.params.data),
      });
    });
    if (interactionBroker !== undefined) {
      this.#client.setRequestHandler(
        'roots/list',
        async (request, context) =>
          (await interactionBroker.handle(
            this.serverId,
            'roots/list',
            request.params ?? {},
            context.mcpReq.signal,
          )) as never,
      );
      if (interactionBroker.supportsSampling === true) {
        this.#client.setRequestHandler(
          'sampling/createMessage',
          async (request, context) =>
            (await interactionBroker.handle(
              this.serverId,
              'sampling/createMessage',
              request.params,
              context.mcpReq.signal,
            )) as never,
        );
      }
      this.#client.setRequestHandler(
        'elicitation/create',
        async (request, context) =>
          (await interactionBroker.handle(
            this.serverId,
            'elicitation/create',
            request.params,
            context.mcpReq.signal,
          )) as never,
      );
    }
  }

  get state(): McpConnectionPort['state'] {
    return this.#state;
  }

  get tasksEnabled(): boolean {
    return this.#tasks !== undefined;
  }

  get skillsEnabled(): boolean {
    return this.#skills !== undefined;
  }

  get appsEnabled(): boolean {
    return this.#appsEnabled;
  }

  get directoryReadEnabled(): boolean {
    const settings = this.discovery?.capabilities.extensions?.['io.modelcontextprotocol/skills'];
    return this.#skills !== undefined && settings?.directoryRead === true;
  }

  set state(value: McpConnectionPort['state']) {
    if (this.#state === value) return;
    this.#state = value;
    for (const listener of this.#stateListeners) listener(value);
  }

  onStateChange(listener: (state: McpConnectionPort['state']) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  onEvent(listener: (event: McpHostEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  emitCatalogChanged(
    catalog: Extract<McpHostEvent, { readonly type: 'catalog-changed' }>['catalog'],
    error: Error | null,
  ): void {
    this.#emit({
      type: 'catalog-changed',
      serverId: this.serverId,
      catalog,
      ...(error === null ? {} : { error: error.message }),
    });
  }

  #emit(event: McpHostEvent): void {
    for (const listener of this.#eventListeners) listener(event);
  }

  markReady(): void {
    const era = this.#client.getProtocolEra();
    const version = this.#client.getNegotiatedProtocolVersion();
    if (era === undefined || version === undefined) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP server ${this.serverId} completed without a negotiated protocol`,
        { serverId: this.serverId },
      );
    }
    const serverInfo = this.#client.getServerVersion();
    const discover = this.#client.getDiscoverResult();
    const capabilities = (this.#client.getServerCapabilities() ??
      {}) as McpServerDiscovery['capabilities'] & {
      readonly extensions?: Readonly<Record<string, unknown>>;
    };
    this.discovery = {
      protocol: { era, version },
      ...(serverInfo === undefined
        ? {}
        : {
            serverInfo: {
              name: serverInfo.name,
              ...(serverInfo.title === undefined ? {} : { title: serverInfo.title }),
              version: serverInfo.version,
              ...(serverInfo.description === undefined
                ? {}
                : { description: serverInfo.description }),
              ...(serverInfo.websiteUrl === undefined ? {} : { websiteUrl: serverInfo.websiteUrl }),
              ...(serverInfo.icons === undefined
                ? {}
                : { icons: serverInfo.icons.map(normalizeIcon) }),
            },
          }),
      capabilities,
      extensions:
        capabilities.extensions === undefined ? [] : Object.keys(capabilities.extensions).sort(),
      ...(discover?.instructions === undefined ? {} : { instructions: discover.instructions }),
    };
    this.state = 'ready';
  }

  enableTasks(enabled: boolean): void {
    if (!enabled || this.#tasks !== undefined) return;
    const protocolVersion = this.#client.getNegotiatedProtocolVersion();
    if (protocolVersion === undefined) {
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', 'MCP Tasks require a negotiated connection', {
        serverId: this.serverId,
      });
    }
    const adapterOptions =
      this.#taskTransport === undefined
        ? {}
        : {
            rawDispatch: this.#taskTransport.dispatch.bind(this.#taskTransport),
            v2RequestFraming: {
              protocolVersion,
              clientInfo: CLIENT_INFO,
              clientCapabilities: this.#clientCapabilities,
            },
          };
    const session = createTaskSessionFromClient(this.#client, {
      endpointId: this.#endpointId,
      ...adapterOptions,
      ...(this.#interactionBroker === undefined
        ? {}
        : {
            onInputRequest: async (request, context) => {
              const method =
                request.kind === 'elicitation'
                  ? 'elicitation/create'
                  : request.kind === 'sampling'
                    ? 'sampling/createMessage'
                    : 'roots/list';
              return (await this.#interactionBroker?.handle(
                this.serverId,
                method,
                request.params ?? {},
                context.signal,
              )) as never;
            },
          }),
    });
    this.#tasks = new McpTaskAdapter(session);
  }

  enableSkills(enabled: boolean): void {
    if (!enabled || this.#skills !== undefined) return;
    const settings = this.discovery?.capabilities.extensions?.['io.modelcontextprotocol/skills'];
    if (settings === undefined) return;
    if (this.discovery?.capabilities.resources === undefined) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP server ${this.serverId} advertises Skills without Resources`,
        { serverId: this.serverId },
      );
    }
    const request: McpSkillProtocolRequest = (message, resultSchema, options) =>
      this.#client.request(message as never, resultSchema as never, options);
    this.#skills = new McpSkillsProtocol(this.serverId, request, {
      directoryRead: settings.directoryRead === true,
    });
  }

  enableApps(enabled: boolean): void {
    if (!enabled) return;
    if (this.discovery?.capabilities.resources === undefined) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP server ${this.serverId} advertises Apps without Resources`,
        { serverId: this.serverId },
      );
    }
    this.#appsEnabled = true;
  }

  async listSkills(): Promise<readonly McpSkill[]> {
    if (this.#skills === undefined) return [];
    return this.#skills.list();
  }

  async getSkill(uri: string): Promise<McpSkill> {
    if (this.#skills === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Skills is unavailable on ${this.serverId}`,
        {
          serverId: this.serverId,
        },
      );
    }
    return this.#skills.get(uri, { refresh: true });
  }

  async readSkillResource(uri: string): Promise<Pick<McpSkillFile, 'uri' | 'bytes' | 'mimeType'>> {
    const result = await this.readResource(uri, { timeoutMs: 30_000 });
    return decodeSkillResourceResult(uri, result);
  }

  async readSkillDirectory(uri: string): Promise<readonly McpSkillDirectoryEntry[]> {
    if (this.#skills === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Skills is unavailable on ${this.serverId}`,
        {
          serverId: this.serverId,
        },
      );
    }
    return this.#skills.readDirectory(uri);
  }

  async listTools(): Promise<readonly NativeMcpTool[]> {
    try {
      const result = await this.#client.listTools(undefined, { timeout: 10_000 });
      this.#toolDeclarations.clear();
      return result.tools
        .filter((tool) => !hasNumberMcpHeader(tool.inputSchema))
        .map((tool) => {
          const declaration: NativeMcpTool = {
            name: tool.name,
            ...(tool.title === undefined ? {} : { title: tool.title }),
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
            ...(tool.annotations === undefined
              ? {}
              : { annotations: normalizeAnnotations(tool.annotations) }),
            ...(tool.icons === undefined ? {} : { icons: tool.icons.map(normalizeIcon) }),
            ...(tool._meta === undefined
              ? {}
              : { meta: tool._meta as Readonly<Record<string, JsonValue>> }),
            ...(tool.execution?.taskSupport === undefined
              ? {}
              : { taskSupport: tool.execution.taskSupport }),
          };
          this.#toolDeclarations.set(tool.name, declaration);
          return declaration;
        });
    } catch (error) {
      throw mapConnectionError(this.serverId, error);
    }
  }

  async callTool(
    nativeName: string,
    argumentsValue: JsonValue,
    options: McpCallOptions,
  ): Promise<NativeMcpResult> {
    if (this.state !== 'ready') {
      throw new PlinthwayError(
        'MCP_CONNECTION_FAILED',
        `MCP server ${this.serverId} is unavailable`,
        {
          serverId: this.serverId,
        },
      );
    }
    if (this.#tasks !== undefined && this.#toolDeclarations.has(nativeName)) {
      const execution = await this.callToolTask(nativeName, argumentsValue, options);
      const outcome = await execution.settle({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onEvent: (event) => {
          const task = event.type === 'task' ? event.task : event.outcome.task;
          if (task !== undefined)
            this.#emit({ type: 'task-updated', serverId: this.serverId, task });
        },
      });
      if (outcome.status === 'completed') return outcome.result;
      if (outcome.status === 'cancelled') {
        throw new PlinthwayError(
          'CANCELLED',
          `MCP tool ${this.serverId}.${nativeName} was cancelled`,
          {
            serverId: this.serverId,
            toolName: nativeName,
          },
        );
      }
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP tool ${this.serverId}.${nativeName} task failed: ${outcome.error.message}`,
        { serverId: this.serverId, toolName: nativeName },
      );
    }
    try {
      const result = await this.#client.callTool(
        { name: nativeName, arguments: argumentsValue as Record<string, unknown> },
        {
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      return {
        content: result.content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result._meta === undefined
          ? {}
          : { meta: result._meta as Readonly<Record<string, JsonValue>> }),
      };
    } catch (error) {
      throw mapCallError(this.serverId, nativeName, error, options.signal);
    }
  }

  async callToolTask(
    nativeName: string,
    argumentsValue: JsonValue,
    options: McpCallOptions,
  ): Promise<McpTaskExecution> {
    if (this.state !== 'ready') {
      throw new PlinthwayError(
        'MCP_CONNECTION_FAILED',
        `MCP server ${this.serverId} is unavailable`,
        { serverId: this.serverId },
      );
    }
    const declaration = this.#toolDeclarations.get(nativeName);
    if (this.#tasks === undefined || declaration === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${this.serverId}.${nativeName}`,
        { serverId: this.serverId, toolName: nativeName },
      );
    }
    try {
      const execution = await this.#tasks.callTool(
        nativeName,
        argumentsValue,
        options,
        declaration,
      );
      return this.#withTaskSubscription(execution);
    } catch (error) {
      throw mapCallError(this.serverId, nativeName, error, options.signal);
    }
  }

  async getTask(taskId: string, options: McpCallOptions): Promise<McpTaskView> {
    if (this.#tasks === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${this.serverId}`,
      );
    }
    return this.#tasks.getTask(taskId, options.signal);
  }

  async updateTask(
    taskId: string,
    inputResponses: Readonly<Record<string, JsonValue>>,
    options: McpCallOptions,
  ): Promise<void> {
    if (this.#tasks === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${this.serverId}`,
      );
    }
    await this.#tasks.updateTask(taskId, inputResponses, options.signal);
  }

  async cancelTask(taskId: string, options: McpCallOptions): Promise<void> {
    if (this.#tasks === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${this.serverId}`,
      );
    }
    await this.#tasks.cancelTask(taskId, options.signal);
  }

  async resumeTask(
    reference: McpTaskReference,
    options: McpCallOptions,
  ): Promise<McpTaskExecution> {
    if (this.#tasks === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${this.serverId}`,
      );
    }
    return this.#withTaskSubscription(await this.#tasks.resumeTask(reference, options));
  }

  #withTaskSubscription(execution: McpTaskExecution): McpTaskExecution {
    if (
      execution.kind !== 'task' ||
      execution.reference === undefined ||
      this.discovery?.protocol.era !== 'modern' ||
      this.#taskTransport === undefined
    ) {
      return execution;
    }
    const controller = new AbortController();
    const clientCapabilities = this.#clientCapabilities;
    const extensions =
      clientCapabilities.extensions !== null &&
      typeof clientCapabilities.extensions === 'object' &&
      !Array.isArray(clientCapabilities.extensions)
        ? (clientCapabilities.extensions as Readonly<Record<string, JsonValue>>)
        : {};
    void this.#taskTransport
      .dispatch(
        {
          method: 'subscriptions/listen',
          params: {
            notifications: { taskIds: [execution.reference.taskId] },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': this.discovery.protocol.version,
              'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
              'io.modelcontextprotocol/clientCapabilities': {
                ...clientCapabilities,
                extensions: { ...extensions, 'io.modelcontextprotocol/tasks': {} },
              },
            },
          },
        },
        { signal: controller.signal },
      )
      .catch(() => undefined);
    const stop = (): void => {
      controller.abort();
    };
    return {
      ...execution,
      detach: async () => {
        stop();
        await execution.detach();
      },
      close: async () => {
        stop();
        await execution.close();
      },
    };
  }

  async listPrompts(): Promise<readonly NativeMcpPrompt[]> {
    try {
      const result = await this.#client.listPrompts(undefined, { timeout: 10_000 });
      return result.prompts.map((prompt) => normalizeMetadata(prompt) as NativeMcpPrompt);
    } catch (error) {
      throw mapConnectionError(this.serverId, error);
    }
  }

  async getPrompt(
    name: string,
    argumentsValue: Readonly<Record<string, string>>,
    options: McpCallOptions,
  ): Promise<NativeMcpPromptResult> {
    try {
      const result = await this.#client.getPrompt(
        { name, arguments: { ...argumentsValue } },
        {
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      return normalizeMetadata(result) as unknown as NativeMcpPromptResult;
    } catch (error) {
      throw mapCallError(this.serverId, name, error, options.signal);
    }
  }

  async listResources(): Promise<readonly NativeMcpResource[]> {
    try {
      const result = await this.#client.listResources(undefined, { timeout: 10_000 });
      return result.resources.map((resource) => normalizeMetadata(resource) as NativeMcpResource);
    } catch (error) {
      throw mapConnectionError(this.serverId, error);
    }
  }

  async listResourceTemplates(): Promise<readonly NativeMcpResourceTemplate[]> {
    try {
      const result = await this.#client.listResourceTemplates(undefined, { timeout: 10_000 });
      return result.resourceTemplates.map(
        (resourceTemplate) => normalizeMetadata(resourceTemplate) as NativeMcpResourceTemplate,
      );
    } catch (error) {
      throw mapConnectionError(this.serverId, error);
    }
  }

  async readResource(uri: string, options: McpCallOptions): Promise<NativeMcpResourceResult> {
    try {
      const result = await this.#client.readResource(
        { uri },
        {
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      return normalizeMetadata(result) as unknown as NativeMcpResourceResult;
    } catch (error) {
      throw mapCallError(this.serverId, uri, error, options.signal);
    }
  }

  async complete(
    reference:
      | { readonly type: 'prompt'; readonly name: string }
      | { readonly type: 'resource-template'; readonly uri: string },
    argument: { readonly name: string; readonly value: string },
    context: Readonly<Record<string, string>> | undefined,
    options: McpCallOptions,
  ): Promise<NativeMcpCompletionResult> {
    try {
      const result = await this.#client.complete(
        {
          ref:
            reference.type === 'prompt'
              ? { type: 'ref/prompt', name: reference.name }
              : { type: 'ref/resource', uri: reference.uri },
          argument: { ...argument },
          ...(context === undefined ? {} : { context: { arguments: { ...context } } }),
        },
        {
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      return {
        values: [...result.completion.values],
        ...(result.completion.total === undefined ? {} : { total: result.completion.total }),
        ...(result.completion.hasMore === undefined ? {} : { hasMore: result.completion.hasMore }),
        ...(result._meta === undefined
          ? {}
          : { meta: normalizedJson(result._meta) as Readonly<Record<string, JsonValue>> }),
      };
    } catch (error) {
      throw mapCallError(this.serverId, argument.name, error, options.signal);
    }
  }

  async subscribeResource(uri: string, options: McpCallOptions): Promise<void> {
    try {
      await this.#client.subscribeResource(
        { uri },
        {
          timeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      throw mapCallError(this.serverId, uri, error, options.signal);
    }
  }

  async unsubscribeResource(uri: string, options: McpCallOptions): Promise<void> {
    try {
      await this.#client.unsubscribeResource(
        { uri },
        {
          timeout: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      throw mapCallError(this.serverId, uri, error, options.signal);
    }
  }

  async ping(options: McpCallOptions): Promise<void> {
    try {
      await this.#client.ping({
        timeout: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw mapCallError(this.serverId, 'ping', error, options.signal);
    }
  }

  async setLoggingLevel(level: McpLoggingLevel, options: McpCallOptions): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required during the spec's compatibility window.
      await this.#client.setLoggingLevel(level, {
        timeout: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw mapCallError(this.serverId, 'logging/setLevel', error, options.signal);
    }
  }

  async sendRootsListChanged(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required during the spec's compatibility window.
      await this.#client.sendRootsListChanged();
    } catch (error) {
      throw mapConnectionError(this.serverId, error);
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.#closing = true;
    try {
      if (this.#httpTransport !== undefined && this.discovery?.protocol.era === 'legacy') {
        try {
          await this.#httpTransport.terminateSession();
        } catch {
          // The client still must close if the remote session cannot be terminated.
        }
      }
      await this.#tasks?.close();
      this.#tasks = undefined;
      await this.#client.close();
    } finally {
      this.state = 'closed';
      this.#closing = false;
    }
  }
}

export async function connectMcpServer(
  config: PublicMcpServerConfig,
  options: ConnectMcpServerOptions = {},
): Promise<McpConnectionPort> {
  let connection: McpConnection | undefined;
  const clientOptions = mcpClientOptions(
    options,
    (catalog, error) => connection?.emitCatalogChanged(catalog, error),
    {
      tasks: config.extensions?.tasks === true,
      skills: config.extensions?.skills === true,
      apps: config.extensions?.apps === true,
      oauthClientCredentials: config.extensions?.oauthClientCredentials === true,
      enterpriseManagedAuth: config.extensions?.enterpriseManagedAuth === true,
    },
  );
  const client = new Client(CLIENT_INFO, clientOptions);
  const clientCapabilities = normalizedJson(clientOptions.capabilities ?? {}) as Readonly<
    Record<string, JsonValue>
  >;
  const endpointId = `mcp:${sha256(canonicalJson(config))}`;
  try {
    if (config.transport === 'stdio') {
      validateStdioConfig(config);
      const env = minimalEnvironment(config.env, options.environment ?? process.env);
      const command = await resolveExecutable(config.command, config.cwd, env);
      const innerTransport = new StdioClientTransport({
        command,
        args: [...config.args],
        env,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        stderr: 'ignore',
        maxBufferSize: 2 * 1024 * 1024,
      });
      await client.connect(innerTransport, { timeout: options.connectTimeoutMs ?? 10_000 });
      const transport = new TaskMultiplexTransport(innerTransport);
      transport.attachStarted();
      connection = new McpConnection(
        config.id,
        client,
        undefined,
        options.interactionBroker,
        transport,
        clientCapabilities,
        endpointId,
      );
    } else {
      const url = new URL(config.url);
      await assertAllowedMcpUrl(url, options.allowedHttpOrigins ?? [], options.lookup);
      const httpTransport = new StreamableHTTPClientTransport(url, {
        ...(options.oauthProvider === undefined ? {} : { authProvider: options.oauthProvider }),
        requestInit: {
          redirect: 'manual',
          ...(options.credentialHeaders === undefined
            ? {}
            : { headers: options.credentialHeaders }),
        },
        fetch: createRestrictedFetch({
          originalUrl: url,
          allowedOrigins: options.allowedHttpOrigins ?? [],
          credentialHeaderNames: Object.keys(options.credentialHeaders ?? {}),
          credentialOrigins: options.oauthCredentialOrigins ?? [],
          ...(options.isOAuthCredentialDestination === undefined
            ? {}
            : { isCredentialDestination: options.isOAuthCredentialDestination }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
        }),
        redirectPolicy: 'follow',
      });
      await client.connect(httpTransport, { timeout: options.connectTimeoutMs ?? 10_000 });
      const transport = new TaskMultiplexTransport(httpTransport);
      transport.attachStarted();
      connection = new McpConnection(
        config.id,
        client,
        httpTransport,
        options.interactionBroker,
        transport,
        clientCapabilities,
        endpointId,
      );
    }
    connection.markReady();
    connection.enableTasks(config.extensions?.tasks === true);
    connection.enableSkills(config.extensions?.skills === true);
    connection.enableApps(config.extensions?.apps === true);
    return connection;
  } catch (error) {
    if (connection === undefined) await client.close().catch(() => undefined);
    else await connection.close().catch(() => undefined);
    throw mapConnectionError(config.id, error);
  }
}
