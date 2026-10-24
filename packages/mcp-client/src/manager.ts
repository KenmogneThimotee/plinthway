import {
  canonicalJson,
  PlinthwayError,
  sha256,
  type JsonValue,
  type McpRoot,
  type PublicMcpServerConfig,
  type ToolAction,
  type ToolRule,
} from '@plinthway/shared';
import { PolicyEngine } from '@plinthway/policy';
import {
  McpAppHost,
  discoverAppTools,
  isAppVisibleTool,
  isModelVisibleTool,
  toolVisibility,
  type AppSession,
  type AppInvocationContext,
  type AppToolCall,
  type McpAppDescriptor,
} from '@plinthway/mcp-app-host';

import { CapabilityCatalogs } from './catalogs.js';
import type {
  McpCallOptions,
  McpConnectionPort,
  McpConnector,
  McpHostEvent,
  McpLoggingLevel,
  McpPersistedTask,
  McpPrompt,
  McpPromptResult,
  McpResource,
  McpResourceResult,
  McpResourceTemplate,
  McpServerStatus,
  McpTool,
  McpToolResult,
  McpTaskExecution,
  McpTaskOutcome,
  McpTaskRepositoryPort,
  McpTaskStartResult,
  McpTaskView,
  NativeMcpCompletionResult,
  NativeMcpResult,
  NativeMcpTool,
} from './contracts.js';
import { BoundedResponseCacheStore } from './response-cache.js';
import { McpInteractionBroker } from './interaction-broker.js';
import {
  McpOAuthController,
  type McpOAuthAuthorizationInput,
  type McpOAuthAuthorizationResult,
} from './oauth-provider.js';
import { McpSupervisor, type McpSupervisedGeneration } from './supervisor.js';
import { assertAllowedPublicMcpUrl } from './network-policy.js';
import { ToolCatalog } from './tool-catalog.js';
import {
  McpSkillHost,
  type McpActiveSkill,
  type McpSkill,
  type McpSkillApprovalRequest,
  type McpSkillConnectionPort,
  type McpSkillDirectoryEntry,
  type McpSkillFile,
} from './skills.js';

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BLOCK_BYTES = 1024 * 1024;
const MAX_CAPABILITY_RESULT_BYTES = 16 * 1024 * 1024;

interface ConnectionSet {
  readonly generation: McpSupervisedGeneration;
  readonly catalog: ToolCatalog;
  readonly policyCatalog: ToolCatalog;
  readonly capabilities: CapabilityCatalogs;
  readonly skills: McpSkillHost;
  readonly apps: Map<string, AppCatalogEntry>;
  readonly appTools: Map<string, AppToolCatalogEntry>;
  readonly connections: Map<string, McpConnectionPort>;
  readonly profileGenerationId: string;
  readonly appPolicy: AppPolicySettings;
}

interface MutableCatalogSet {
  readonly catalog: ToolCatalog;
  readonly policyCatalog: ToolCatalog;
  readonly capabilities: CapabilityCatalogs;
  readonly skills: McpSkillHost;
  readonly apps: Map<string, AppCatalogEntry>;
  readonly appTools: Map<string, AppToolCatalogEntry>;
  readonly connections: Map<string, McpConnectionPort>;
}

interface AppCatalogEntry {
  readonly descriptor: McpAppDescriptor;
  readonly connection: McpConnectionPort;
}

interface AppToolCatalogEntry {
  readonly connection: McpConnectionPort;
  readonly native: NativeMcpTool;
  readonly visibility: readonly ('model' | 'app')[];
}

function connectionIsReady(connection: McpConnectionPort): boolean {
  return connection.state === 'ready';
}

function appToolDefinition(tool: NativeMcpTool): Readonly<Record<string, unknown>> {
  const definition: Record<string, unknown> = { ...tool };
  if (tool.meta !== undefined) {
    definition._meta = tool.meta;
    Reflect.deleteProperty(definition, 'meta');
  }
  return definition;
}

export interface AppPolicySettings {
  readonly defaultPolicy: ToolAction;
  readonly rules: readonly ToolRule[];
}

export interface McpAppApprovalRequest {
  readonly appSessionId: string;
  readonly auditSessionId: string;
  readonly callId: string;
  readonly profileGenerationId: string;
  readonly readOnlyHint: boolean;
  readonly serverId: string;
  readonly toolName: string;
  readonly resourceUri: string;
  readonly arguments: JsonValue;
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOversizedTextBlock(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  return (
    value.type === 'text' &&
    typeof value.text === 'string' &&
    Buffer.byteLength(value.text) > MAX_TEXT_BLOCK_BYTES
  );
}

export interface McpManagerOptions {
  readonly connect: McpConnector;
  readonly responseCache?: BoundedResponseCacheStore;
  readonly interactions?: McpInteractionBroker;
  readonly oauth?: McpOAuthController;
  readonly taskRepository?: McpTaskRepositoryPort;
  readonly approveSkill?: (request: McpSkillApprovalRequest) => Promise<boolean>;
  readonly approveApp?: (request: McpAppApprovalRequest) => Promise<boolean>;
  readonly now?: () => Date;
  readonly maxConcurrent?: number;
  readonly activationTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly random?: () => number;
}

function normalizeResult(result: NativeMcpResult, serverId: string, toolName: string): JsonValue {
  let serialized: string;
  try {
    serialized = canonicalJson(result.content);
  } catch (error) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP tool ${toolName} returned non-JSON content`,
      { serverId, toolName },
      { cause: error },
    );
  }
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new PlinthwayError('PAYLOAD_TOO_LARGE', `MCP result from ${toolName} exceeds 2 MiB`, {
      serverId,
      toolName,
    });
  }
  const normalized = JSON.parse(serialized) as JsonValue;
  if (Array.isArray(normalized)) {
    for (const block of normalized as readonly JsonValue[]) {
      if (isOversizedTextBlock(block)) {
        throw new PlinthwayError(
          'PAYLOAD_TOO_LARGE',
          `MCP text result from ${toolName} exceeds 1 MiB`,
          {
            serverId,
            toolName,
          },
        );
      }
    }
  }
  return normalized;
}

function normalizeOptionalResultValue(
  value: unknown,
  serverId: string,
  toolName: string,
): JsonValue {
  try {
    return JSON.parse(canonicalJson(value)) as JsonValue;
  } catch (error) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP tool ${toolName} returned non-JSON structured content`,
      { serverId, toolName },
      { cause: error },
    );
  }
}

function normalizeToolResult(
  result: NativeMcpResult,
  serverId: string,
  toolName: string,
): McpToolResult {
  return {
    trusted: false,
    serverId,
    toolName,
    content: normalizeResult(result, serverId, toolName),
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: normalizeOptionalResultValue(
            result.structuredContent,
            serverId,
            toolName,
          ),
        }),
    isError: result.isError === true,
    ...(result.meta === undefined ? {} : { meta: { ...result.meta } }),
  };
}

function normalizeCapabilityResult<T>(value: T, serverId: string, operation: string): T {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP ${operation} returned a non-JSON result`,
      { serverId, operation },
      { cause: error },
    );
  }
  if (Buffer.byteLength(serialized) > MAX_CAPABILITY_RESULT_BYTES) {
    throw new PlinthwayError('PAYLOAD_TOO_LARGE', `MCP ${operation} result exceeds 16 MiB`, {
      serverId,
      operation,
    });
  }
  return JSON.parse(serialized) as T;
}

function invokeWithBoundary<T>(
  operation: () => Promise<T>,
  toolName: string,
  options: McpCallOptions,
): Promise<T> {
  if (options.signal?.aborted === true) {
    return Promise.reject(new PlinthwayError('CANCELLED', `MCP tool ${toolName} was cancelled`));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new PlinthwayError('TIMEOUT', `MCP tool ${toolName} timed out`, { toolName }));
    }, options.timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(new PlinthwayError('CANCELLED', `MCP tool ${toolName} was cancelled`, { toolName }));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void operation().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new PlinthwayError('MCP_PROTOCOL_ERROR', `MCP tool ${toolName} failed`),
        );
      },
    );
  });
}

export class McpManager {
  readonly responseCache: BoundedResponseCacheStore;
  readonly interactions: McpInteractionBroker;
  readonly oauth: McpOAuthController;
  readonly #supervisor: McpSupervisor;
  readonly #eventListeners = new Set<(event: McpHostEvent) => void>();
  readonly #events: McpHostEvent[] = [];
  readonly #taskRepository: McpTaskRepositoryPort | undefined;
  readonly #approveSkill: (request: McpSkillApprovalRequest) => Promise<boolean>;
  readonly #approveApp: (request: McpAppApprovalRequest) => Promise<boolean>;
  readonly #appHost: McpAppHost;
  readonly #now: () => Date;
  readonly #taskDrivers = new Map<string, Promise<McpTaskOutcome>>();
  readonly #activeAppCalls = new Set<Promise<unknown>>();
  #appApprovalQueue: Promise<void> = Promise.resolve();
  #appCallsBlocked = false;
  #active: ConnectionSet | undefined;
  #prepared: ConnectionSet | undefined;

  constructor(options: McpManagerOptions) {
    this.responseCache = options.responseCache ?? new BoundedResponseCacheStore();
    this.interactions = options.interactions ?? new McpInteractionBroker();
    this.oauth = options.oauth ?? new McpOAuthController();
    this.#taskRepository = options.taskRepository;
    this.#approveSkill = options.approveSkill ?? (() => Promise.resolve(false));
    this.#approveApp = options.approveApp ?? (() => Promise.resolve(false));
    this.#now = options.now ?? (() => new Date());
    this.#appHost = new McpAppHost({
      readResource: async (serverId, uri) => {
        return this.readResource(serverId, uri, { timeoutMs: 30_000 });
      },
      listTools: (serverId) =>
        [...(this.#active?.appTools.values() ?? [])]
          .filter((entry) => entry.connection.serverId === serverId)
          .map((entry) => ({ toolName: entry.native.name, visibility: entry.visibility })),
      listToolDefinitions: (serverId) =>
        [...(this.#active?.appTools.values() ?? [])]
          .filter((entry) => entry.connection.serverId === serverId)
          .sort((left, right) => left.native.name.localeCompare(right.native.name))
          .map((entry) => appToolDefinition(entry.native)),
      listResources: (serverId) =>
        (this.#active?.capabilities.listResources() ?? [])
          .filter((resource) => resource.serverId === serverId)
          .map((resource) => {
            const publicResource: Record<string, unknown> = { ...resource };
            Reflect.deleteProperty(publicResource, 'serverId');
            if (resource.meta !== undefined) {
              publicResource._meta = resource.meta;
              Reflect.deleteProperty(publicResource, 'meta');
            }
            return publicResource;
          }),
      authorizeOrigin: async (origin) => {
        if (origin.includes('://*.')) return false;
        try {
          const url = new URL(origin);
          if (url.protocol === 'ws:') url.protocol = 'http:';
          if (url.protocol === 'wss:') url.protocol = 'https:';
          await assertAllowedPublicMcpUrl(url);
          return true;
        } catch {
          return false;
        }
      },
      callTool: (request) => this.#invokeAppTool(request),
    });
    this.#supervisor = new McpSupervisor({
      connect: options.connect,
      ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
      ...(options.activationTimeoutMs === undefined
        ? {}
        : { activationTimeoutMs: options.activationTimeoutMs }),
      ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
      ...(options.retryMaxMs === undefined ? {} : { retryMaxMs: options.retryMaxMs }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  async prepare(
    servers: readonly PublicMcpServerConfig[],
    roots: readonly McpRoot[] = [],
    profileGenerationId = 'unscoped',
    appPolicy: AppPolicySettings = { defaultPolicy: 'ask', rules: [] },
  ): Promise<void> {
    await this.rollback();
    this.interactions.setRoots(roots);
    const catalog = new ToolCatalog();
    const policyCatalog = new ToolCatalog();
    const capabilities = new CapabilityCatalogs();
    const skills = new McpSkillHost({ approve: this.#approveSkill });
    const apps = new Map<string, AppCatalogEntry>();
    const appTools = new Map<string, AppToolCatalogEntry>();
    const connections = new Map<string, McpConnectionPort>();
    const catalogs: MutableCatalogSet = {
      catalog,
      policyCatalog,
      capabilities,
      skills,
      apps,
      appTools,
      connections,
    };
    const generation = await this.#supervisor.prepare(servers, {
      connectionOptions: (config) => ({
        responseCacheStore: this.responseCache,
        cachePartition: sha256(canonicalJson({ profileGenerationId, server: config })),
        interactionBroker: this.interactions,
      }),
      onConnection: async (connection) => {
        await this.#refreshCatalogs(catalogs, connection, false);
        connections.set(connection.serverId, connection);
        connection.onEvent?.((event) => {
          this.#emit(event);
          if (event.type === 'catalog-changed' && event.error === undefined) {
            void this.#refreshCatalogs(catalogs, connection, true).catch((error: unknown) => {
              this.#emit({
                ...event,
                error: error instanceof Error ? error.message : 'Catalog refresh failed',
              });
            });
          }
        });
      },
      onDisconnection: (connection) => {
        catalog.remove(connection);
        policyCatalog.remove(connection);
        capabilities.remove(connection);
        skills.removeServer(connection.serverId);
        for (const [name, entry] of apps) {
          if (entry.connection === connection) apps.delete(name);
        }
        for (const [name, entry] of appTools) {
          if (entry.connection === connection) appTools.delete(name);
        }
        void this.#appHost.closeServer(connection.serverId);
        if (connections.get(connection.serverId) === connection) {
          connections.delete(connection.serverId);
        }
      },
    });
    this.#prepared = {
      generation,
      catalog,
      policyCatalog,
      capabilities,
      skills,
      apps,
      appTools,
      connections,
      profileGenerationId,
      appPolicy,
    };
  }

  onEvent(listener: (event: McpHostEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  authorize(
    serverId: string,
    input: McpOAuthAuthorizationInput = {},
  ): Promise<McpOAuthAuthorizationResult> {
    return this.oauth.authorize(serverId, input).then(async (result) => {
      const authorizationChanged = async (): Promise<void> => {
        this.responseCache.clear();
        await Promise.all([
          this.#active?.generation.reconnect(serverId),
          this.#prepared?.generation.reconnect(serverId),
        ]);
      };
      if (result.state === 'authorized') {
        await authorizationChanged();
        return result;
      }
      if (result.waitForCompletion === undefined) return result;
      const waitForCompletion = result.waitForCompletion;
      let reconnection: Promise<void> | undefined;
      return {
        ...result,
        waitForCompletion: async (signal) => {
          await waitForCompletion(signal);
          reconnection ??= authorizationChanged();
          await reconnection;
        },
      };
    });
  }

  reconnect(serverId: string): void {
    void this.#active?.generation.reconnect(serverId);
    void this.#prepared?.generation.reconnect(serverId);
  }

  #emit(event: McpHostEvent): void {
    this.#events.push(event);
    if (this.#events.length > 1_000) this.#events.splice(0, this.#events.length - 1_000);
    for (const listener of this.#eventListeners) listener(event);
  }

  listEvents(serverId?: string): readonly McpHostEvent[] {
    return this.#events.filter((event) => serverId === undefined || event.serverId === serverId);
  }

  async #refreshCatalogs(
    catalogs: MutableCatalogSet,
    connection: McpConnectionPort,
    replace: boolean,
  ): Promise<void> {
    if (replace && catalogs.connections.get(connection.serverId) !== connection) return;
    const advertised = connection.discovery?.capabilities;
    const skillConnection =
      connection.skillsEnabled === true ? this.#skillConnection(connection) : undefined;
    const [tools, prompts, resources, resourceTemplates, commitSkills] = await Promise.all([
      advertised === undefined || advertised.tools !== undefined
        ? connection.listTools()
        : Promise.resolve([]),
      connection.listPrompts !== undefined &&
      (advertised === undefined || advertised.prompts !== undefined)
        ? connection.listPrompts()
        : Promise.resolve([]),
      connection.listResources !== undefined &&
      (advertised === undefined || advertised.resources !== undefined)
        ? connection.listResources()
        : Promise.resolve([]),
      connection.listResourceTemplates !== undefined &&
      (advertised === undefined || advertised.resources !== undefined)
        ? connection.listResourceTemplates()
        : Promise.resolve([]),
      skillConnection === undefined
        ? Promise.resolve(undefined)
        : catalogs.skills.prepareServer(skillConnection),
    ]);

    const stagedTools = new ToolCatalog();
    const stagedPolicyTools = new ToolCatalog();
    const stagedCapabilities = new CapabilityCatalogs();
    const stagedApps = new Map<string, AppCatalogEntry>();
    const stagedAppTools = new Map<string, AppToolCatalogEntry>();
    for (const tool of tools) {
      if (isModelVisibleTool(tool)) stagedTools.add(connection, tool);
      if (isModelVisibleTool(tool) || (connection.appsEnabled === true && isAppVisibleTool(tool))) {
        stagedPolicyTools.add(connection, tool);
      }
      if (connection.appsEnabled === true && isAppVisibleTool(tool)) {
        stagedAppTools.set(`${connection.serverId}.${tool.name}`, {
          connection,
          native: tool,
          visibility: toolVisibility(tool),
        });
      }
    }
    stagedCapabilities.add(connection, { prompts, resources, resourceTemplates });
    if (connection.appsEnabled === true) {
      for (const descriptor of discoverAppTools(connection.serverId, tools)) {
        stagedApps.set(descriptor.qualifiedName, {
          descriptor,
          connection,
        });
      }
    }
    if (replace && catalogs.connections.get(connection.serverId) !== connection) return;
    if (replace) {
      catalogs.catalog.remove(connection);
      catalogs.policyCatalog.remove(connection);
      catalogs.capabilities.remove(connection);
      for (const [name, entry] of catalogs.apps) {
        if (entry.connection === connection) catalogs.apps.delete(name);
      }
      for (const [name, entry] of catalogs.appTools) {
        if (entry.connection === connection) catalogs.appTools.delete(name);
      }
    }
    for (const tool of tools) {
      if (isModelVisibleTool(tool)) catalogs.catalog.add(connection, tool);
      if (isModelVisibleTool(tool) || (connection.appsEnabled === true && isAppVisibleTool(tool))) {
        catalogs.policyCatalog.add(connection, tool);
      }
    }
    for (const [name, entry] of stagedApps) catalogs.apps.set(name, entry);
    for (const [name, entry] of stagedAppTools) catalogs.appTools.set(name, entry);
    catalogs.capabilities.add(connection, { prompts, resources, resourceTemplates });
    commitSkills?.();
  }

  #skillConnection(connection: McpConnectionPort): McpSkillConnectionPort {
    if (
      connection.skillsEnabled !== true ||
      connection.listSkills === undefined ||
      connection.getSkill === undefined ||
      connection.readSkillResource === undefined ||
      connection.readSkillDirectory === undefined
    ) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP server ${connection.serverId} has an incomplete Skills adapter`,
        { serverId: connection.serverId },
      );
    }
    return {
      serverId: connection.serverId,
      skillsEnabled: true,
      directoryReadEnabled: connection.directoryReadEnabled === true,
      listSkills: () => connection.listSkills?.() ?? Promise.resolve([]),
      getSkill: (uri) => connection.getSkill?.(uri) ?? Promise.reject(new Error('unavailable')),
      readSkillResource: (uri) =>
        connection.readSkillResource?.(uri) ?? Promise.reject(new Error('unavailable')),
      readSkillDirectory: (uri) =>
        connection.readSkillDirectory?.(uri) ?? Promise.reject(new Error('unavailable')),
    };
  }

  async commit(): Promise<void> {
    if (this.#prepared === undefined) {
      throw new PlinthwayError('MCP_CONNECTION_FAILED', 'No prepared MCP connections to commit');
    }
    const previous = this.#active;
    this.#appCallsBlocked = true;
    try {
      await this.#appHost.close();
      await Promise.allSettled([...this.#activeAppCalls]);
      this.#active = this.#prepared;
      this.#prepared = undefined;
      if (previous !== undefined) await previous.generation.close();
      await this.#resumePersistedTasks(this.#active);
    } finally {
      this.#appCallsBlocked = false;
    }
  }

  async rollback(): Promise<void> {
    const prepared = this.#prepared;
    this.#prepared = undefined;
    if (prepared !== undefined) await prepared.generation.close();
  }

  listTools(): readonly McpTool[] {
    return this.#active?.catalog.list() ?? [];
  }

  listApps(): readonly McpAppDescriptor[] {
    return [...(this.#active?.apps.values() ?? [])]
      .map((entry) => entry.descriptor)
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  }

  async openApp(qualifiedName: string, context: AppInvocationContext): Promise<AppSession> {
    const active = this.#active;
    const entry = active?.apps.get(qualifiedName);
    if (active === undefined || entry === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP App ${qualifiedName} is unavailable`,
        {
          qualifiedName,
        },
      );
    }
    const session = await this.#appHost.open(entry.descriptor, context);
    if (this.#active !== active || !connectionIsReady(entry.connection)) {
      await session.close();
      throw new PlinthwayError(
        'TOOL_DENIED',
        `MCP App ${qualifiedName} belongs to a superseded profile generation`,
        { qualifiedName, profileGenerationId: active.profileGenerationId },
      );
    }
    return session;
  }

  closeApp(sessionId: string): Promise<void> {
    const session = this.#appHost.list().find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      return Promise.reject(
        new PlinthwayError('SESSION_NOT_FOUND', `MCP App session ${sessionId} was not found`, {
          sessionId,
        }),
      );
    }
    return session.close();
  }

  listAppSessions(): readonly AppSession[] {
    return this.#appHost.list();
  }

  #approveAppSerially(request: McpAppApprovalRequest): Promise<boolean> {
    const result = this.#appApprovalQueue.then(() => this.#approveApp(request));
    this.#appApprovalQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #appCallIsCurrent(active: ConnectionSet, connection: McpConnectionPort): boolean {
    return !this.#appCallsBlocked && this.#active === active && connectionIsReady(connection);
  }

  async #invokeAppTool(request: AppToolCall): Promise<McpToolResult> {
    const active = this.#active;
    const qualifiedName = `${request.serverId}.${request.toolName}`;
    const appTool = active?.appTools.get(qualifiedName);
    const entry = active?.policyCatalog.get(qualifiedName);
    if (
      active === undefined ||
      entry === undefined ||
      appTool === undefined ||
      entry.connection.state !== 'ready' ||
      !appTool.visibility.includes('app') ||
      appTool.connection.serverId !== request.serverId ||
      this.#appCallsBlocked
    ) {
      throw new PlinthwayError('TOOL_DENIED', `MCP App tool ${request.toolName} is unavailable`, {
        serverId: request.serverId,
        toolName: request.toolName,
      });
    }
    const validated = entry.validate(request.arguments);
    const decision = new PolicyEngine({
      enabledServers: [...active.connections.keys()],
      defaultPolicy: active.appPolicy.defaultPolicy,
      rules: active.appPolicy.rules,
      tools: active.policyCatalog.list(),
    }).decide({
      toolName: entry.tool.name,
      arguments: validated,
    });
    if (decision.action === 'deny') {
      throw new PlinthwayError(
        'TOOL_DENIED',
        `MCP App tool ${request.toolName} is denied by policy`,
        {
          serverId: request.serverId,
          toolName: request.toolName,
          reason: decision.reason,
        },
      );
    }
    if (
      decision.action === 'ask' &&
      !(await this.#approveAppSerially({
        appSessionId: request.appSessionId,
        auditSessionId: request.auditSessionId,
        callId: request.callId,
        profileGenerationId: active.profileGenerationId,
        readOnlyHint: entry.tool.annotations?.readOnlyHint === true,
        serverId: request.serverId,
        toolName: request.toolName,
        resourceUri: request.resourceUri,
        arguments: validated,
      }))
    ) {
      throw new PlinthwayError('TOOL_DENIED', `MCP App tool ${request.toolName} was denied`, {
        serverId: request.serverId,
        toolName: request.toolName,
      });
    }
    if (!this.#appCallIsCurrent(active, entry.connection)) {
      throw new PlinthwayError(
        'TOOL_DENIED',
        `MCP App tool ${request.toolName} belongs to a superseded profile generation`,
        { serverId: request.serverId, toolName: request.toolName },
      );
    }
    const invocation = invokeWithBoundary(
      () => entry.connection.callTool(appTool.native.name, validated, { timeoutMs: 30_000 }),
      entry.tool.name,
      { timeoutMs: 30_000 },
    );
    this.#activeAppCalls.add(invocation);
    try {
      const result = await invocation;
      return normalizeToolResult(result, request.serverId, entry.tool.name);
    } finally {
      this.#activeAppCalls.delete(invocation);
    }
  }

  listPreparedTools(): readonly McpTool[] {
    return this.#prepared?.policyCatalog.list() ?? [];
  }

  listPrompts(): readonly McpPrompt[] {
    return this.#active?.capabilities.listPrompts() ?? [];
  }

  listResources(): readonly McpResource[] {
    return this.#active?.capabilities.listResources() ?? [];
  }

  listResourceTemplates(): readonly McpResourceTemplate[] {
    return this.#active?.capabilities.listResourceTemplates() ?? [];
  }

  listSkills(): readonly McpSkill[] {
    return this.#active?.skills.list() ?? [];
  }

  getSkill(serverId: string, uri: string): Promise<McpSkill> {
    const skills = this.#active?.skills;
    if (skills === undefined) {
      return Promise.reject(
        new PlinthwayError('CAPABILITY_UNSUPPORTED', 'No active MCP Skills catalog'),
      );
    }
    return skills.get(serverId, uri);
  }

  activateSkill(
    serverId: string,
    uri: string,
    options: { readonly requestedBy: 'model' | 'user' } = { requestedBy: 'user' },
  ): Promise<McpActiveSkill> {
    const skills = this.#active?.skills;
    if (skills === undefined) {
      return Promise.reject(
        new PlinthwayError('CAPABILITY_UNSUPPORTED', 'No active MCP Skills catalog'),
      );
    }
    return skills.activate(serverId, uri, options);
  }

  deactivateSkill(serverId: string, uri: string): void {
    this.#active?.skills.deactivate(serverId, uri);
  }

  readSkill(serverId: string, skillUri: string, reference: string): Promise<McpSkillFile> {
    const skills = this.#active?.skills;
    if (skills === undefined) {
      return Promise.reject(
        new PlinthwayError('CAPABILITY_UNSUPPORTED', 'No active MCP Skills catalog'),
      );
    }
    return skills.read(serverId, skillUri, reference);
  }

  readSkillDirectory(
    serverId: string,
    skillUri: string,
    reference: string,
  ): Promise<readonly McpSkillDirectoryEntry[]> {
    const skills = this.#active?.skills;
    if (skills === undefined) {
      return Promise.reject(
        new PlinthwayError('CAPABILITY_UNSUPPORTED', 'No active MCP Skills catalog'),
      );
    }
    return skills.readDirectory(serverId, skillUri, reference);
  }

  listActiveSkillContexts(): readonly string[] {
    return this.#active?.skills.listActive().map((skill) => skill.context) ?? [];
  }

  listActiveSkills(): readonly McpActiveSkill[] {
    return this.#active?.skills.listActive() ?? [];
  }

  async getPrompt(
    promptName: string,
    argumentsValue: Readonly<Record<string, string>>,
    options: McpCallOptions,
  ): Promise<McpPromptResult> {
    const entry = this.#active?.capabilities.getPrompt(promptName);
    if (entry?.connection.getPrompt === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP prompt ${promptName} is unavailable`,
        {
          promptName,
        },
      );
    }
    const getPrompt = entry.connection.getPrompt;
    const result = await invokeWithBoundary(
      () => getPrompt(entry.prompt.nativeName, argumentsValue, options),
      promptName,
      options,
    );
    return {
      trusted: false,
      serverId: entry.prompt.serverId,
      promptName,
      ...normalizeCapabilityResult(result, entry.prompt.serverId, `prompt ${promptName}`),
    };
  }

  async readResource(
    serverId: string,
    uri: string,
    options: McpCallOptions,
  ): Promise<McpResourceResult> {
    const connection =
      this.#active?.capabilities.getResource(serverId, uri)?.connection ??
      this.#active?.connections.get(serverId);
    if (connection?.readResource === undefined) {
      throw new PlinthwayError('CAPABILITY_UNSUPPORTED', `MCP resource ${uri} is unavailable`, {
        serverId,
        uri,
      });
    }
    const readResource = connection.readResource;
    const result = await invokeWithBoundary(() => readResource(uri, options), uri, options);
    return {
      trusted: false,
      serverId,
      uri,
      ...normalizeCapabilityResult(result, serverId, `resource ${uri}`),
    };
  }

  async completePrompt(
    promptName: string,
    argument: { readonly name: string; readonly value: string },
    context: Readonly<Record<string, string>> | undefined,
    options: McpCallOptions,
  ): Promise<NativeMcpCompletionResult> {
    const entry = this.#active?.capabilities.getPrompt(promptName);
    if (entry?.connection.complete === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP completion for ${promptName} is unavailable`,
        { promptName },
      );
    }
    const complete = entry.connection.complete;
    return invokeWithBoundary(
      () => complete({ type: 'prompt', name: entry.prompt.nativeName }, argument, context, options),
      promptName,
      options,
    );
  }

  async completeResourceTemplate(
    serverId: string,
    uriTemplate: string,
    argument: { readonly name: string; readonly value: string },
    context: Readonly<Record<string, string>> | undefined,
    options: McpCallOptions,
  ): Promise<NativeMcpCompletionResult> {
    const entry = this.#active?.capabilities.getResourceTemplate(serverId, uriTemplate);
    if (entry?.connection.complete === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP completion for ${uriTemplate} is unavailable`,
        { serverId, uriTemplate },
      );
    }
    const complete = entry.connection.complete;
    return invokeWithBoundary(
      () =>
        complete(
          { type: 'resource-template', uri: entry.resourceTemplate.uriTemplate },
          argument,
          context,
          options,
        ),
      uriTemplate,
      options,
    );
  }

  async subscribeResource(serverId: string, uri: string, options: McpCallOptions): Promise<void> {
    const connection = this.#active?.connections.get(serverId);
    if (connection?.subscribeResource === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP resource subscriptions are unavailable for ${serverId}`,
        { serverId, uri },
      );
    }
    const subscribe = connection.subscribeResource;
    await invokeWithBoundary(() => subscribe(uri, options), uri, options);
  }

  async unsubscribeResource(serverId: string, uri: string, options: McpCallOptions): Promise<void> {
    const connection = this.#active?.connections.get(serverId);
    if (connection?.unsubscribeResource === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP resource subscriptions are unavailable for ${serverId}`,
        { serverId, uri },
      );
    }
    const unsubscribe = connection.unsubscribeResource;
    await invokeWithBoundary(() => unsubscribe(uri, options), uri, options);
  }

  async ping(serverId: string, options: McpCallOptions): Promise<void> {
    const ping = this.#active?.connections.get(serverId)?.ping;
    if (ping === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP ping is unavailable for ${serverId}`,
        {
          serverId,
        },
      );
    }
    await invokeWithBoundary(() => ping(options), 'ping', options);
  }

  async setLoggingLevel(
    serverId: string,
    level: McpLoggingLevel,
    options: McpCallOptions,
  ): Promise<void> {
    const setLevel = this.#active?.connections.get(serverId)?.setLoggingLevel;
    if (setLevel === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP logging is unavailable for ${serverId}`,
        { serverId },
      );
    }
    await invokeWithBoundary(() => setLevel(level, options), 'logging/setLevel', options);
  }

  async sendRootsListChanged(serverId: string): Promise<void> {
    const notify = this.#active?.connections.get(serverId)?.sendRootsListChanged;
    if (notify === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP roots notifications are unavailable for ${serverId}`,
        { serverId },
      );
    }
    await notify();
  }

  status(): readonly McpServerStatus[] {
    return this.#active?.generation.status() ?? [];
  }

  async invoke(
    toolName: string,
    argumentsValue: unknown,
    options: McpCallOptions,
  ): Promise<McpToolResult> {
    const entry = this.#active?.catalog.get(toolName);
    if (entry === undefined) {
      throw new PlinthwayError('TOOL_NOT_FOUND', `MCP tool ${toolName} is not enabled`, {
        toolName,
      });
    }
    if (entry.connection.state !== 'ready') {
      throw new PlinthwayError(
        'MCP_CONNECTION_FAILED',
        `MCP server ${entry.tool.serverId} is degraded`,
        {
          serverId: entry.tool.serverId,
        },
      );
    }
    const validated = entry.validate(argumentsValue);
    if (
      entry.connection.tasksEnabled === true &&
      entry.connection.callToolTask !== undefined &&
      entry.tool.taskSupport !== 'forbidden'
    ) {
      const callToolTask = entry.connection.callToolTask;
      const execution = await invokeWithBoundary(
        () => callToolTask(entry.tool.nativeName, validated, options),
        toolName,
        options,
      );
      if (execution.kind === 'immediate') {
        const outcome = await invokeWithBoundary(
          () => execution.settle(),
          toolName,
          options,
        ).finally(() => execution.close().catch(() => undefined));
        if (outcome.status === 'completed') {
          return normalizeToolResult(outcome.result, entry.tool.serverId, toolName);
        }
        if (outcome.status === 'cancelled') {
          throw new PlinthwayError('CANCELLED', `MCP task for ${toolName} was cancelled`, {
            toolName,
          });
        }
        throw new PlinthwayError('MCP_PROTOCOL_ERROR', outcome.error.message, { toolName });
      }
      if (execution.reference === undefined) {
        throw new PlinthwayError(
          'MCP_PROTOCOL_ERROR',
          'MCP task execution has no durable reference',
          {
            toolName,
          },
        );
      }
      const now = this.#now().toISOString();
      const record: McpPersistedTask = {
        serverId: entry.tool.serverId,
        profileGenerationId: this.#active?.profileGenerationId ?? 'unscoped',
        toolName,
        reference: execution.reference,
        status: 'working',
        createdAt: now,
        updatedAt: now,
      };
      await this.#taskRepository?.upsert(record);
      const outcome = await invokeWithBoundary(
        () => this.#startTaskDriver(execution, record),
        toolName,
        options,
      );
      if (outcome.status === 'completed') {
        return normalizeToolResult(outcome.result, entry.tool.serverId, toolName);
      }
      if (outcome.status === 'cancelled') {
        throw new PlinthwayError('CANCELLED', `MCP task for ${toolName} was cancelled`, {
          toolName,
        });
      }
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', outcome.error.message, { toolName });
    }
    const result = await invokeWithBoundary(
      () => entry.connection.callTool(entry.tool.nativeName, validated, options),
      toolName,
      options,
    );
    return normalizeToolResult(result, entry.tool.serverId, toolName);
  }

  async startTask(
    toolName: string,
    argumentsValue: unknown,
    options: McpCallOptions,
  ): Promise<McpTaskStartResult> {
    const active = this.#active;
    const entry = active?.catalog.get(toolName);
    if (active === undefined || entry === undefined) {
      throw new PlinthwayError('TOOL_NOT_FOUND', `MCP tool ${toolName} is not enabled`, {
        toolName,
      });
    }
    if (entry.connection.tasksEnabled !== true || entry.connection.callToolTask === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${toolName}`,
        {
          toolName,
        },
      );
    }
    const validated = entry.validate(argumentsValue);
    const execution = await entry.connection.callToolTask(
      entry.tool.nativeName,
      validated,
      options,
    );
    if (execution.kind === 'immediate') {
      const outcome = await execution.settle({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await execution.close();
      if (outcome.status === 'completed') {
        return {
          kind: 'immediate',
          result: normalizeToolResult(outcome.result, entry.tool.serverId, toolName),
        };
      }
      if (outcome.status === 'cancelled') {
        throw new PlinthwayError('CANCELLED', `MCP task for ${toolName} was cancelled`, {
          toolName,
        });
      }
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', outcome.error.message, { toolName });
    }
    if (execution.reference === undefined) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        'MCP task execution has no durable reference',
        {
          toolName,
        },
      );
    }
    const now = this.#now().toISOString();
    const record: McpPersistedTask = {
      serverId: entry.tool.serverId,
      profileGenerationId: active.profileGenerationId,
      toolName,
      reference: execution.reference,
      status: 'working',
      createdAt: now,
      updatedAt: now,
    };
    await this.#taskRepository?.upsert(record);
    void this.#startTaskDriver(execution, record);
    return { kind: 'task', task: record };
  }

  async listTasks(): Promise<readonly McpPersistedTask[]> {
    if (this.#taskRepository === undefined) return [];
    return this.#taskRepository.list(this.#active?.profileGenerationId);
  }

  async getTask(
    serverId: string,
    taskId: string,
    options: McpCallOptions,
  ): Promise<McpPersistedTask> {
    const connection = this.#active?.connections.get(serverId);
    if (connection?.getTask === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP Tasks are unavailable for ${serverId}`,
        {
          serverId,
          taskId,
        },
      );
    }
    const existing = await this.#taskRepository?.get(
      serverId,
      taskId,
      this.#active?.profileGenerationId ?? 'unscoped',
    );
    if (existing === undefined) {
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', `MCP task ${taskId} is not known`, {
        serverId,
        taskId,
      });
    }
    const task = await connection.getTask(taskId, options);
    const record = this.#recordTaskView(existing, task);
    await this.#taskRepository?.upsert(record);
    this.#emit({ type: 'task-updated', serverId, task });
    return record;
  }

  async updateTask(
    serverId: string,
    taskId: string,
    inputResponses: Readonly<Record<string, JsonValue>>,
    options: McpCallOptions,
  ): Promise<McpPersistedTask> {
    const update = this.#active?.connections.get(serverId)?.updateTask;
    if (update === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP task input is unavailable for ${serverId}`,
        {
          serverId,
          taskId,
        },
      );
    }
    await update(taskId, inputResponses, options);
    return this.getTask(serverId, taskId, options);
  }

  async cancelTask(serverId: string, taskId: string, options: McpCallOptions): Promise<void> {
    const cancel = this.#active?.connections.get(serverId)?.cancelTask;
    if (cancel === undefined) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP task cancellation is unavailable for ${serverId}`,
        { serverId, taskId },
      );
    }
    await cancel(taskId, options);
    const existing = await this.#taskRepository?.get(
      serverId,
      taskId,
      this.#active?.profileGenerationId ?? 'unscoped',
    );
    if (existing !== undefined) {
      await this.#taskRepository?.upsert({
        ...existing,
        status: 'cancelled',
        updatedAt: this.#now().toISOString(),
      });
    }
  }

  #recordTaskView(record: McpPersistedTask, task: McpTaskView): McpPersistedTask {
    let expiresAt: string | undefined;
    if (task.retentionMs !== null) {
      const created = Date.parse(task.createdAt ?? record.createdAt);
      if (Number.isFinite(created)) expiresAt = new Date(created + task.retentionMs).toISOString();
    }
    return {
      ...record,
      status: task.status,
      task,
      updatedAt: this.#now().toISOString(),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  #startTaskDriver(
    execution: McpTaskExecution,
    initial: McpPersistedTask,
  ): Promise<McpTaskOutcome> {
    const key = `${initial.profileGenerationId}\0${initial.serverId}\0${initial.reference.taskId}`;
    const driver = this.#driveTask(execution, initial).finally(() => {
      if (this.#taskDrivers.get(key) === driver) this.#taskDrivers.delete(key);
    });
    this.#taskDrivers.set(key, driver);
    void driver.catch(() => undefined);
    return driver;
  }

  async #driveTask(
    execution: McpTaskExecution,
    initial: McpPersistedTask,
  ): Promise<McpTaskOutcome> {
    let record = initial;
    try {
      const outcome = await execution.settle({
        onEvent: async (event) => {
          const task = event.type === 'task' ? event.task : event.outcome.task;
          if (task === undefined) return;
          record = this.#recordTaskView(record, task);
          await this.#taskRepository?.upsert(record);
          this.#emit({ type: 'task-updated', serverId: record.serverId, task });
        },
      });
      record = {
        ...record,
        status: outcome.status,
        updatedAt: this.#now().toISOString(),
        ...(outcome.status === 'completed'
          ? {
              result: normalizeToolResult(outcome.result, record.serverId, record.toolName),
            }
          : {}),
        ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      };
      await this.#taskRepository?.upsert(record);
      return outcome;
    } catch (error) {
      record = { ...record, status: 'failed', updatedAt: this.#now().toISOString() };
      await this.#taskRepository?.upsert(record);
      throw error;
    } finally {
      await execution.close().catch(() => undefined);
    }
  }

  async #resumePersistedTasks(active: ConnectionSet): Promise<void> {
    const records = await this.#taskRepository?.list(active.profileGenerationId);
    if (records === undefined) return;
    for (const record of records) {
      if (['completed', 'failed', 'cancelled'].includes(record.status)) continue;
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.#now().getTime()) {
        await this.#taskRepository?.upsert({
          ...record,
          status: 'failed',
          updatedAt: this.#now().toISOString(),
        });
        continue;
      }
      const resume = active.connections.get(record.serverId)?.resumeTask;
      if (resume === undefined) continue;
      try {
        const execution = await resume(record.reference, { timeoutMs: 30_000 });
        void this.#startTaskDriver(execution, record);
      } catch {
        await this.#taskRepository?.upsert({
          ...record,
          status: 'failed',
          updatedAt: this.#now().toISOString(),
        });
      }
    }
  }

  async disconnect(): Promise<void> {
    this.#appCallsBlocked = true;
    try {
      const active = this.#active;
      const prepared = this.#prepared;
      this.#active = undefined;
      this.#prepared = undefined;
      await this.#appHost.close().catch(() => undefined);
      await Promise.allSettled([...this.#activeAppCalls]);
      await Promise.allSettled([
        ...(active === undefined ? [] : [active.generation.close()]),
        ...(prepared === undefined ? [] : [prepared.generation.close()]),
      ]);
    } finally {
      this.#appCallsBlocked = false;
    }
  }
}
