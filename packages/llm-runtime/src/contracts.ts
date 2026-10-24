import type { Credential } from '@plinthway/auth';
import type { GlobalConfig, ModelOverride, ProviderConfig } from '@plinthway/config';
import type { ModelMetadata } from '@plinthway/model-registry';
import type { LLMEvent, LLMRequest, LLMResponse, ResolvedModel } from '@plinthway/shared';
import type { LanguageModel } from 'ai';

export interface ModelRequirements {
  readonly toolCalls?: boolean;
  readonly reasoning?: boolean;
  readonly structuredOutput?: boolean;
  readonly minimumContext?: number;
  readonly minimumOutput?: number;
}

export interface ProviderAdapter {
  readonly providerId: string;
  createModel(input: {
    readonly modelId: string;
    readonly baseURL?: string;
    readonly credential: Credential;
    readonly connectionId?: string;
  }): Promise<LanguageModel>;
}

export type ProviderAdapterFactory = () => Promise<ProviderAdapter>;

export interface ModelCatalog {
  get(id: string): Promise<ModelMetadata>;
}

export interface AuthCredentialResolver {
  getCredentials(pluginId: string, account?: string): Promise<Credential>;
}

export interface PreparedModel {
  readonly model: ResolvedModel;
  readonly languageModel: LanguageModel;
  readonly adapter: ProviderConfig['adapter'];
}

export interface PreparedModelResolver {
  resolve(
    modelRef: string,
    requirements?: ModelRequirements,
    binding?: ProfileRuntimeBinding,
  ): Promise<PreparedModel>;
  prepared(modelRef: string): PreparedModel | undefined;
}

export interface ProfileProviderDefinition {
  readonly adapter: ProviderConfig['adapter'];
  readonly baseURL?: string;
  readonly auth:
    | { readonly mode: 'none' }
    | { readonly mode: 'api-key'; readonly credential: 'keyring' }
    | { readonly mode: 'oauth'; readonly service: 'chatgpt'; readonly connectionId: string };
  readonly models: Readonly<Record<string, ModelOverride>>;
}

export interface ProfileRuntimeBinding {
  readonly profileId: string;
  readonly providers: Readonly<Record<string, ProfileProviderDefinition>>;
}

export interface ProfileCredentialResolver {
  get(profileId: string, providerId: string): Promise<Credential>;
}

export interface ProfileModelResolverOptions {
  readonly registry: ModelCatalog;
  readonly credentials: ProfileCredentialResolver;
  readonly adapterFactories: Readonly<
    Partial<Record<ProviderConfig['adapter'], ProviderAdapterFactory>>
  >;
}

export interface ModelResolverOptions {
  readonly registry: ModelCatalog;
  readonly auth: AuthCredentialResolver;
  readonly config: GlobalConfig;
  readonly adapterFactories: Readonly<
    Partial<Record<ProviderConfig['adapter'], ProviderAdapterFactory>>
  >;
}

export interface AIStreamResult {
  readonly fullStream: AsyncIterable<unknown>;
}

export interface AIGenerateResult {
  readonly text: string;
  readonly toolCalls?: readonly unknown[];
  readonly usage?: unknown;
  readonly finishReason: string;
}

export interface AITextFunctions {
  streamText(options: Record<string, unknown>): AIStreamResult | Promise<AIStreamResult>;
  generateText(options: Record<string, unknown>): Promise<AIGenerateResult>;
  jsonSchema(schema: unknown): unknown;
}

export interface LLMRuntime {
  resolve(
    modelRef: string,
    requirements?: ModelRequirements,
    binding?: ProfileRuntimeBinding,
  ): Promise<ResolvedModel>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}
