import { ProfileModelCatalog } from '@plinthway/model-registry';
import { canonicalJson, PlinthwayError, sha256, type ResolvedModel } from '@plinthway/shared';

import type {
  ModelRequirements,
  PreparedModel,
  PreparedModelResolver,
  ProfileModelResolverOptions,
  ProfileRuntimeBinding,
  ProviderAdapter,
} from './contracts.js';

export class ProfileModelResolver implements PreparedModelResolver {
  readonly #options: ProfileModelResolverOptions;
  readonly #adapters = new Map<string, Promise<ProviderAdapter>>();
  readonly #prepared = new Map<string, PreparedModel>();

  constructor(options: ProfileModelResolverOptions) {
    this.#options = options;
  }

  async #adapter(adapterId: keyof ProfileModelResolverOptions['adapterFactories']) {
    const factory = this.#options.adapterFactories[adapterId];
    if (factory === undefined) {
      throw new PlinthwayError(
        'ADAPTER_UNSUPPORTED',
        `Provider adapter ${adapterId} is unavailable`,
      );
    }
    let adapter = this.#adapters.get(adapterId);
    if (adapter === undefined) {
      adapter = factory();
      this.#adapters.set(adapterId, adapter);
    }
    return adapter;
  }

  async resolve(
    modelRef: string,
    requirements: ModelRequirements = {},
    binding?: ProfileRuntimeBinding,
  ): Promise<PreparedModel> {
    const separator = modelRef.indexOf('/');
    const providerId = separator < 1 ? '' : modelRef.slice(0, separator);
    const modelId = separator < 1 ? '' : modelRef.slice(separator + 1);
    if (binding === undefined || binding.providers[providerId] === undefined) {
      throw new PlinthwayError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider ${providerId || '(missing)'} is not configured for this profile`,
        { providerId, ...(binding === undefined ? {} : { profileId: binding.profileId }) },
      );
    }
    const provider = binding.providers[providerId];
    const metadata = await new ProfileModelCatalog(this.#options.registry, binding.providers).get(
      modelRef,
    );
    const missing =
      (requirements.toolCalls === true && !metadata.capabilities.toolCalls) ||
      (requirements.reasoning === true && !metadata.capabilities.reasoning) ||
      (requirements.structuredOutput === true && !metadata.capabilities.structuredOutput) ||
      (requirements.minimumContext !== undefined &&
        (metadata.contextLimit === undefined ||
          metadata.contextLimit < requirements.minimumContext)) ||
      (requirements.minimumOutput !== undefined &&
        (metadata.outputLimit === undefined || metadata.outputLimit < requirements.minimumOutput));
    if (missing) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `Model ${modelRef} does not satisfy the requested capabilities`,
        { modelId: modelRef },
      );
    }
    const bindingId = `profile:${sha256(
      canonicalJson({ profileId: binding.profileId, providerId, provider }),
    )}`;
    const cached = this.#prepared.get(bindingId);
    if (cached !== undefined) return cached;
    const adapter = await this.#adapter(provider.adapter);
    const credential =
      provider.auth.mode === 'api-key'
        ? await this.#options.credentials.get(binding.profileId, providerId)
        : { type: 'none' as const };
    const languageModel = await adapter.createModel({
      modelId,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      credential,
      ...(provider.auth.mode === 'oauth' ? { connectionId: provider.auth.connectionId } : {}),
    });
    const model: ResolvedModel = {
      ref: metadata.id,
      bindingId,
      providerId,
      modelId,
      capabilities: metadata.capabilities,
      ...(metadata.contextLimit === undefined ? {} : { contextLimit: metadata.contextLimit }),
      ...(metadata.outputLimit === undefined ? {} : { outputLimit: metadata.outputLimit }),
    };
    const prepared = { model, languageModel, adapter: provider.adapter };
    this.#prepared.set(bindingId, prepared);
    return prepared;
  }

  prepared(bindingId: string): PreparedModel | undefined {
    return this.#prepared.get(bindingId);
  }
}
