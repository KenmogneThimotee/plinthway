import type { ChatGptModel } from '@plinthway/auth';
import type { CatalogSnapshot, ModelMetadata, ProviderMetadata } from '@plinthway/model-registry';
import type { ProfileProvider } from '@plinthway/profiles';

import type { ProviderCapability } from './provider-capability.js';

export interface ProfileCatalogModel extends ModelMetadata {
  readonly execution: ProviderCapability;
  readonly current: boolean;
}

export interface ProfileCatalogGroup {
  readonly provider: ProviderMetadata;
  readonly execution: ProviderCapability;
  readonly models: readonly ProfileCatalogModel[];
}

export interface ProfileModelCatalogSnapshot {
  readonly groups: readonly ProfileCatalogGroup[];
  readonly accountRefreshErrors: Readonly<Record<string, string>>;
  readonly cached: boolean;
}

export interface MergeProfileModelCatalogInput {
  readonly base: CatalogSnapshot;
  readonly providers: Readonly<Record<string, ProfileProvider>>;
  readonly current?: string;
  readonly capabilities: ReadonlyMap<string, ProviderCapability>;
  readonly accountModels?: Readonly<Record<string, readonly ChatGptModel[]>>;
  readonly accountRefreshErrors: Readonly<Record<string, string>>;
  readonly cached: boolean;
}

const unsupported: ProviderCapability = Object.freeze({
  status: 'adapter-required',
  authVariables: Object.freeze([]),
  reason: 'No runtime capability was resolved for this provider',
});

function profileModel(
  providerId: string,
  modelId: string,
  declaration: ProfileProvider['models'][string],
  base?: ModelMetadata,
): ModelMetadata {
  const contextLimit = declaration.contextLimit ?? base?.contextLimit;
  const outputLimit = declaration.outputLimit ?? base?.outputLimit;
  return Object.freeze({
    id: `${providerId}/${modelId}`,
    providerId,
    modelId,
    name: declaration.name ?? base?.name ?? modelId,
    ...(contextLimit === undefined ? {} : { contextLimit }),
    ...(outputLimit === undefined ? {} : { outputLimit }),
    capabilities: Object.freeze({
      toolCalls: declaration.toolCalls ?? base?.capabilities.toolCalls ?? false,
      reasoning: declaration.reasoning ?? base?.capabilities.reasoning ?? false,
      structuredOutput:
        declaration.structuredOutput ?? base?.capabilities.structuredOutput ?? false,
    }),
  });
}

function syntheticProvider(providerId: string, provider: ProfileProvider): ProviderMetadata {
  return Object.freeze({
    id: providerId,
    name: providerId === 'chatgpt' ? 'ChatGPT subscription' : providerId,
    env: Object.freeze([]),
    ...(provider.baseURL === undefined ? {} : { api: provider.baseURL }),
  });
}

function accountProvider(providerId: string): ProviderMetadata {
  return Object.freeze({
    id: providerId,
    name: providerId === 'chatgpt' ? 'ChatGPT subscription' : providerId,
    env: Object.freeze([]),
  });
}

function addAccountModels(
  models: Map<string, ModelMetadata>,
  providerId: string,
  accountModels: readonly ChatGptModel[],
): void {
  for (const accountModel of accountModels) {
    const id = `${providerId}/${accountModel.id}`;
    models.set(
      id,
      Object.freeze({
        id,
        providerId,
        modelId: accountModel.id,
        name: accountModel.name,
        capabilities: Object.freeze({
          toolCalls: true,
          reasoning: true,
          structuredOutput: true,
        }),
      }),
    );
  }
}

export function mergeProfileModelCatalog(
  input: MergeProfileModelCatalogInput,
): ProfileModelCatalogSnapshot {
  const providers = new Map(input.base.providers);
  const models = new Map(input.base.models);

  for (const [providerId, provider] of Object.entries(input.providers)) {
    if (!providers.has(providerId))
      providers.set(providerId, syntheticProvider(providerId, provider));
    for (const [modelId, declaration] of Object.entries(provider.models)) {
      const id = `${providerId}/${modelId}`;
      models.set(id, profileModel(providerId, modelId, declaration, models.get(id)));
    }
    addAccountModels(models, providerId, input.accountModels?.[providerId] ?? []);
  }

  for (const [providerId, accountModels] of Object.entries(input.accountModels ?? {})) {
    if (!providers.has(providerId)) providers.set(providerId, accountProvider(providerId));
    addAccountModels(models, providerId, accountModels);
  }

  const groups = [...providers.values()]
    .map((provider) => {
      const execution = input.capabilities.get(provider.id) ?? unsupported;
      const providerModels = [...models.values()]
        .filter(({ providerId }) => providerId === provider.id)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        )
        .map((model) =>
          Object.freeze({ ...model, execution, current: model.id === input.current }),
        );
      return Object.freeze({ provider, execution, models: Object.freeze(providerModels) });
    })
    .filter(({ models: providerModels }) => providerModels.length > 0)
    .sort(
      (left, right) =>
        left.provider.name.localeCompare(right.provider.name) ||
        left.provider.id.localeCompare(right.provider.id),
    );

  return Object.freeze({
    groups: Object.freeze(groups),
    accountRefreshErrors: Object.freeze({ ...input.accountRefreshErrors }),
    cached: input.cached,
  });
}
