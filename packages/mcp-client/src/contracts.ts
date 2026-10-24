import type { JsonValue, PublicMcpServerConfig } from '@plinthway/shared';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';

import type { McpInteractionBrokerPort } from './interaction-broker.js';
import type { McpSkillConnectionPort } from './skills.js';

export type McpConnectionState =
  | 'connecting'
  | 'ready'
  | 'auth-required'
  | 'reconnecting'
  | 'degraded'
  | 'incompatible'
  | 'closed';

export interface McpIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: 'light' | 'dark';
}

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpAnnotations {
  readonly audience?: readonly ('user' | 'assistant')[];
  readonly priority?: number;
  readonly lastModified?: string;
}

export interface NativeMcpPromptArgument {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface NativeMcpPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly NativeMcpPromptArgument[];
  readonly icons?: readonly McpIcon[];
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface NativeMcpResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly icons?: readonly McpIcon[];
  readonly annotations?: McpAnnotations;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface NativeMcpResourceTemplate extends Omit<NativeMcpResource, 'uri' | 'size'> {
  readonly uriTemplate: string;
}

export interface NativeMcpPromptResult {
  readonly description?: string;
  readonly messages: readonly JsonValue[];
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface NativeMcpResourceResult {
  readonly contents: readonly JsonValue[];
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface NativeMcpCompletionResult {
  readonly values: readonly string[];
  readonly total?: number;
  readonly hasMore?: boolean;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface NativeMcpTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: McpToolAnnotations | undefined;
  readonly icons?: readonly McpIcon[] | undefined;
  readonly meta?: Readonly<Record<string, JsonValue>> | undefined;
  readonly taskSupport?: 'forbidden' | 'optional' | 'required';
}

export interface NativeMcpResult {
  readonly content: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface McpCallOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type McpTaskState = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskView {
  readonly taskId: string;
  readonly status: McpTaskState;
  readonly statusMessage?: string;
  readonly createdAt?: string;
  readonly lastUpdatedAt?: string;
  readonly retentionMs: number | null;
  readonly suggestedPollIntervalMs?: number;
  readonly raw: Readonly<Record<string, JsonValue>>;
}

export type McpTaskReference =
  | {
      readonly endpointId: string;
      readonly generation: 'v1';
      readonly taskId: string;
      readonly originalOperation: string;
    }
  | {
      readonly endpointId: string;
      readonly generation: 'v2';
      readonly taskId: string;
      readonly originalOperation: string;
    };

export type McpTaskOutcome =
  | { readonly status: 'completed'; readonly result: NativeMcpResult; readonly task?: McpTaskView }
  | {
      readonly status: 'failed';
      readonly error: {
        readonly message: string;
        readonly code?: number;
        readonly data?: JsonValue;
      };
      readonly task?: McpTaskView;
    }
  | { readonly status: 'cancelled'; readonly task?: McpTaskView };

export type McpTaskEvent =
  | { readonly type: 'task'; readonly task: McpTaskView }
  | { readonly type: 'outcome'; readonly outcome: McpTaskOutcome };

export interface McpTaskExecution {
  readonly kind: 'immediate' | 'task';
  readonly reference?: McpTaskReference;
  readonly updates: (signal?: AbortSignal) => AsyncIterable<McpTaskEvent>;
  readonly settle: (options?: {
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: McpTaskEvent) => void | Promise<void>;
  }) => Promise<McpTaskOutcome>;
  readonly cancel: (signal?: AbortSignal) => Promise<void>;
  readonly detach: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface McpPersistedTask {
  readonly serverId: string;
  readonly profileGenerationId: string;
  readonly toolName: string;
  readonly reference: McpTaskReference;
  readonly status: McpTaskState;
  readonly task?: McpTaskView;
  readonly result?: McpToolResult;
  readonly error?: {
    readonly message: string;
    readonly code?: number;
    readonly data?: JsonValue;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface McpTaskRepositoryPort {
  readonly upsert: (task: McpPersistedTask) => Promise<void>;
  readonly get: (
    serverId: string,
    taskId: string,
    profileGenerationId: string,
  ) => Promise<McpPersistedTask | undefined>;
  readonly list: (profileGenerationId?: string) => Promise<readonly McpPersistedTask[]>;
  readonly delete: (serverId: string, taskId: string, profileGenerationId: string) => Promise<void>;
}

export type McpTaskStartResult =
  | { readonly kind: 'immediate'; readonly result: McpToolResult }
  | { readonly kind: 'task'; readonly task: McpPersistedTask };

export type McpLoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export type McpHostEvent =
  | {
      readonly type: 'catalog-changed';
      readonly serverId: string;
      readonly catalog: 'tools' | 'prompts' | 'resources';
      readonly error?: string;
    }
  | {
      readonly type: 'resource-updated';
      readonly serverId: string;
      readonly uri: string;
    }
  | {
      readonly type: 'progress';
      readonly serverId: string;
      readonly progressToken: string | number;
      readonly progress: number;
      readonly total?: number;
      readonly message?: string;
    }
  | {
      readonly type: 'logging';
      readonly serverId: string;
      readonly level: string;
      readonly logger?: string;
      readonly data: JsonValue;
    }
  | {
      readonly type: 'task-updated';
      readonly serverId: string;
      readonly task: McpTaskView;
    };

export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean };
  readonly prompts?: { readonly listChanged?: boolean };
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
  readonly completions?: Readonly<Record<string, JsonValue>>;
  readonly logging?: Readonly<Record<string, JsonValue>>;
  readonly tasks?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  readonly experimental?: Readonly<Record<string, JsonValue>>;
}

export interface McpServerDiscovery {
  readonly protocol: {
    readonly era: 'modern' | 'legacy';
    readonly version: string;
  };
  readonly serverInfo?: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
    readonly description?: string;
    readonly websiteUrl?: string;
    readonly icons?: readonly McpIcon[];
  };
  readonly capabilities: McpServerCapabilities;
  readonly extensions: readonly string[];
  readonly instructions?: string;
}

export interface McpConnectionPort extends Partial<McpSkillConnectionPort> {
  readonly serverId: string;
  readonly tasksEnabled?: boolean;
  readonly appsEnabled?: boolean;
  state: McpConnectionState;
  readonly discovery?: McpServerDiscovery | undefined;
  readonly listTools: () => Promise<readonly NativeMcpTool[]>;
  readonly callTool: (
    nativeName: string,
    argumentsValue: JsonValue,
    options: McpCallOptions,
  ) => Promise<NativeMcpResult>;
  readonly callToolTask?: (
    nativeName: string,
    argumentsValue: JsonValue,
    options: McpCallOptions,
  ) => Promise<McpTaskExecution>;
  readonly getTask?: (taskId: string, options: McpCallOptions) => Promise<McpTaskView>;
  readonly updateTask?: (
    taskId: string,
    inputResponses: Readonly<Record<string, JsonValue>>,
    options: McpCallOptions,
  ) => Promise<void>;
  readonly cancelTask?: (taskId: string, options: McpCallOptions) => Promise<void>;
  readonly resumeTask?: (
    reference: McpTaskReference,
    options: McpCallOptions,
  ) => Promise<McpTaskExecution>;
  readonly listPrompts?: () => Promise<readonly NativeMcpPrompt[]>;
  readonly getPrompt?: (
    name: string,
    argumentsValue: Readonly<Record<string, string>>,
    options: McpCallOptions,
  ) => Promise<NativeMcpPromptResult>;
  readonly listResources?: () => Promise<readonly NativeMcpResource[]>;
  readonly listResourceTemplates?: () => Promise<readonly NativeMcpResourceTemplate[]>;
  readonly readResource?: (
    uri: string,
    options: McpCallOptions,
  ) => Promise<NativeMcpResourceResult>;
  readonly complete?: (
    reference:
      | { readonly type: 'prompt'; readonly name: string }
      | { readonly type: 'resource-template'; readonly uri: string },
    argument: { readonly name: string; readonly value: string },
    context: Readonly<Record<string, string>> | undefined,
    options: McpCallOptions,
  ) => Promise<NativeMcpCompletionResult>;
  readonly subscribeResource?: (uri: string, options: McpCallOptions) => Promise<void>;
  readonly unsubscribeResource?: (uri: string, options: McpCallOptions) => Promise<void>;
  readonly ping?: (options: McpCallOptions) => Promise<void>;
  readonly setLoggingLevel?: (level: McpLoggingLevel, options: McpCallOptions) => Promise<void>;
  readonly sendRootsListChanged?: () => Promise<void>;
  readonly onEvent?: (listener: (event: McpHostEvent) => void) => () => void;
  readonly onStateChange?: (listener: (state: McpConnectionState) => void) => () => void;
  readonly close: () => Promise<void>;
}

export type McpConnector = (
  config: PublicMcpServerConfig,
  options?: ConnectMcpServerOptions,
) => Promise<McpConnectionPort>;

export interface McpTool {
  readonly name: string;
  readonly nativeName: string;
  readonly serverId: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema?: JsonValue;
  readonly annotations?: McpToolAnnotations;
  readonly icons?: readonly McpIcon[];
  readonly meta?: Readonly<Record<string, JsonValue>>;
  readonly taskSupport?: 'forbidden' | 'optional' | 'required';
}

export interface McpPrompt extends Omit<NativeMcpPrompt, 'name'> {
  readonly name: string;
  readonly nativeName: string;
  readonly serverId: string;
}

export interface McpResource extends NativeMcpResource {
  readonly serverId: string;
}

export interface McpResourceTemplate extends NativeMcpResourceTemplate {
  readonly serverId: string;
}

export interface McpPromptResult extends NativeMcpPromptResult {
  readonly trusted: false;
  readonly serverId: string;
  readonly promptName: string;
}

export interface McpResourceResult extends NativeMcpResourceResult {
  readonly trusted: false;
  readonly serverId: string;
  readonly uri: string;
}

export interface McpToolResult {
  readonly trusted: false;
  readonly serverId: string;
  readonly toolName: string;
  readonly content: JsonValue;
  readonly structuredContent?: JsonValue;
  readonly isError: boolean;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface McpServerStatus {
  readonly serverId: string;
  readonly state: McpConnectionState;
  readonly protocol?: McpServerDiscovery['protocol'];
  readonly serverInfo?: McpServerDiscovery['serverInfo'];
  readonly capabilities?: McpServerCapabilities;
  readonly extensions?: readonly string[];
  readonly authorization?:
    | { readonly state: 'not-required' }
    | { readonly state: 'required'; readonly reason?: string }
    | { readonly state: 'authorized'; readonly scopes: readonly string[] };
  readonly retryAt?: string;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly deprecationWarnings?: readonly string[];
}

export interface ConnectMcpServerOptions {
  readonly allowedHttpOrigins?: readonly string[];
  readonly credentialHeaders?: Readonly<Record<string, string>>;
  readonly oauthCredentialOrigins?: readonly string[];
  readonly isOAuthCredentialDestination?: (url: URL) => boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  readonly connectTimeoutMs?: number;
  readonly protocolProbeTimeoutMs?: number;
  readonly responseCacheStore?: McpResponseCacheStore;
  readonly cachePartition?: string;
  readonly interactionBroker?: McpInteractionBrokerPort;
  readonly oauthProvider?: OAuthClientProvider;
}

export interface McpResponseCacheKey {
  readonly method: string;
  readonly params?: string;
  readonly partition?: string;
}

export interface McpResponseCacheEntry {
  readonly value: string;
  readonly stamp: number;
  readonly expiresAt?: number;
  readonly scope?: 'public' | 'private';
}

export interface McpResponseCacheStore {
  get(
    key: McpResponseCacheKey,
  ): McpResponseCacheEntry | undefined | Promise<McpResponseCacheEntry | undefined>;
  set(
    key: McpResponseCacheKey,
    entry: {
      readonly value: string;
      readonly expiresAt?: number;
      readonly scope?: 'public' | 'private';
    },
  ): number | Promise<number>;
  delete(key: McpResponseCacheKey): void | Promise<void>;
  evict(method: string): void | Promise<void>;
  clear(): void | Promise<void>;
}
