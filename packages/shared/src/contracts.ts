import type { ProfileId } from './ids.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ToolAction = 'allow' | 'ask' | 'deny';
export type ExecutionStatus =
  'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface ModelParameters {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ToolRule {
  readonly tool: string;
  readonly action: ToolAction;
}

export interface WorkProfile {
  readonly schemaVersion: 1;
  readonly id: ProfileId;
  readonly name: string;
  readonly description?: string;
  readonly model: {
    readonly primary?: string;
    readonly fallback: readonly string[];
    readonly parameters: ModelParameters;
  };
  readonly mcp?: { readonly enabled: readonly string[] };
  readonly tools: {
    readonly defaultPolicy: ToolAction;
    readonly rules: readonly ToolRule[];
  };
  readonly agent: {
    readonly instructionsFile?: string;
    readonly maxSteps: number;
    readonly toolTimeoutSeconds?: number;
  };
  readonly session: { readonly persist: boolean };
}

export interface McpExtensionSettings {
  readonly tasks: boolean;
  readonly skills: boolean;
  readonly apps: boolean;
  readonly oauthClientCredentials: boolean;
  readonly enterpriseManagedAuth: boolean;
}

export interface McpCredentialReference {
  readonly source: 'keyring' | 'plugin';
  readonly id: string;
}

export type McpHttpAuth =
  | { readonly mode: 'none' }
  | { readonly mode: 'bearer'; readonly credential: McpCredentialReference }
  | {
      readonly mode: 'oauth';
      readonly clientId?: string | undefined;
      readonly clientIdMetadataDocument?: string | undefined;
      readonly scopes: readonly string[];
    }
  | {
      readonly mode: 'client-credentials';
      readonly clientId: string;
      readonly issuer: string;
      readonly authentication: 'client-secret-basic' | 'client-secret-post' | 'private-key-jwt';
      readonly credential: McpCredentialReference;
      readonly scopes: readonly string[];
      readonly algorithm: string;
    }
  | { readonly mode: 'enterprise'; readonly managedProfile: string };

export interface McpRoot {
  readonly uri: string;
  readonly name?: string | undefined;
}

export type PublicMcpServerConfig =
  | {
      readonly id: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly env: readonly string[];
      readonly extensions?: McpExtensionSettings;
    }
  | {
      readonly id: string;
      readonly transport: 'streamable-http';
      readonly url: string;
      readonly authPlugin?: string;
      readonly auth?: McpHttpAuth;
      readonly extensions?: McpExtensionSettings;
    };

export interface PublicProviderConfig {
  readonly adapter: 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'openai-chatgpt';
  readonly baseURL?: string;
  readonly auth:
    | { readonly mode: 'none' }
    | { readonly mode: 'api-key'; readonly credential: 'keyring' }
    | { readonly mode: 'oauth'; readonly service: 'chatgpt'; readonly connectionId: string };
  readonly models: Readonly<
    Record<
      string,
      {
        readonly name?: string | undefined;
        readonly contextLimit?: number | undefined;
        readonly outputLimit?: number | undefined;
        readonly toolCalls?: boolean | undefined;
        readonly reasoning?: boolean | undefined;
        readonly structuredOutput?: boolean | undefined;
      }
    >
  >;
}

export interface EffectiveProfile extends Omit<WorkProfile, 'agent' | 'model' | 'mcp'> {
  readonly generationId: string;
  readonly model: {
    readonly primary: string;
    readonly fallback: readonly string[];
    readonly parameters: ModelParameters;
  };
  readonly mcp: { readonly enabled: readonly string[]; readonly roots: readonly McpRoot[] };
  readonly agent: {
    readonly maxSteps: number;
    readonly toolTimeoutSeconds?: number;
  };
  readonly resolvedInstructions?: string;
  readonly resolvedMcpServers: readonly PublicMcpServerConfig[];
  readonly resolvedProviders: Readonly<Record<string, PublicProviderConfig>>;
}

export interface ModelCapabilities {
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
  readonly structuredOutput: boolean;
}

export interface ResolvedModel {
  readonly ref: string;
  readonly bindingId?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly contextLimit?: number;
  readonly outputLimit?: number;
}

export type LLMMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly callId: string;
      readonly toolName: string;
      readonly content: JsonValue;
    };

export interface ToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonValue;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type ToolSource =
  { readonly kind: 'builtin'; readonly id: string } | { readonly kind: 'mcp'; readonly id: string };

export interface ToolDescriptor extends ToolDefinition {
  readonly source: ToolSource;
  readonly annotations?: ToolAnnotations;
  readonly intrinsicAction?: ToolAction;
}

export interface ToolInvocationOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ToolInvocationResult {
  readonly trusted: false;
  readonly toolName: string;
  readonly content: JsonValue;
  readonly structuredContent?: JsonValue;
  readonly isError: boolean;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface ToolInvocationDescription {
  readonly targets: readonly string[];
  readonly readOnlyHint: boolean;
  readonly sideEffects: string;
  readonly riskFloor?: 'allow' | 'ask';
}

export interface ToolProvider {
  listTools(): readonly ToolDescriptor[];
  invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult>;
  describeInvocation?(
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ToolInvocationDescription>;
}

export interface LLMRequest {
  readonly model: ResolvedModel;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly parameters?: ModelParameters;
  readonly timeoutMs?: number;
}

export interface LLMResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly finishReason: 'stop' | 'tool-calls' | 'length' | 'cancelled' | 'error';
}

export type LLMEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly type: 'finish';
      readonly reason: 'stop' | 'tool-calls' | 'length' | 'cancelled' | 'error';
    };
