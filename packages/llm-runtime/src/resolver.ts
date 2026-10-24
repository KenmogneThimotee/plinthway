import { PlinthwayError, type ResolvedModel } from '@plinthway/shared';

import type {
  ModelRequirements,
  ModelResolverOptions,
  PreparedModel,
  ProviderAdapter,
} from './contracts.js';

function parseModelReference(modelRef: string): { providerId: string; modelId: string } {
  const separator = modelRef.indexOf('/');
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new PlinthwayError('MODEL_NOT_FOUND', 'Model references must use provider/model', {
      modelId: modelRef,
    });
  }
  return { providerId: modelRef.slice(0, separator), modelId: modelRef.slice(separator + 1) };
}

function assertRequirements(model: ResolvedModel, requirements: ModelRequirements): void {
  const missing =
    (requirements.toolCalls === true && !model.capabilities.toolCalls) ||
    (requirements.reasoning === true && !model.capabilities.reasoning) ||
    (requirements.structuredOutput === true && !model.capabilities.structuredOutput) ||
    (requirements.minimumContext !== undefined &&
      (model.contextLimit === undefined || model.contextLimit < requirements.minimumContext)) ||
    (requirements.minimumOutput !== undefined &&
      (model.outputLimit === undefined || model.outputLimit < requirements.minimumOutput));
  if (missing) {
    throw new PlinthwayError(
      'CAPABILITY_UNSUPPORTED',
      `Model ${model.ref} does not satisfy the requested capabilities`,
      { modelId: model.ref },
    );
  }
}

export class ModelResolver {
  readonly #options: ModelResolverOptions;
  readonly #adapters = new Map<string, Promise<ProviderAdapter>>();
  readonly #prepared = new Map<string, PreparedModel>();

  constructor(options: ModelResolverOptions) {
    this.#options = options;
  }

  async #adapter(
    adapterId: keyof ModelResolverOptions['adapterFactories'],
  ): Promise<ProviderAdapter> {
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

  async resolve(modelRef: string, requirements: ModelRequirements = {}): Promise<PreparedModel> {
    const parsed = parseModelReference(modelRef);
    let metadata;
    try {
      metadata = await this.#options.registry.get(modelRef);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'MODEL_NOT_FOUND'
      ) {
        throw new PlinthwayError('MODEL_NOT_FOUND', `Model ${modelRef} was not found`, {
          modelId: modelRef,
        });
      }
      throw error;
    }
    const provider = this.#options.config.providers[parsed.providerId];
    if (provider === undefined) {
      throw new PlinthwayError(
        'ADAPTER_UNSUPPORTED',
        `Provider ${parsed.providerId} is not configured`,
      );
    }
    const model: ResolvedModel = {
      ref: metadata.id,
      providerId: metadata.providerId,
      modelId: metadata.modelId,
      capabilities: metadata.capabilities,
      ...(metadata.contextLimit === undefined ? {} : { contextLimit: metadata.contextLimit }),
      ...(metadata.outputLimit === undefined ? {} : { outputLimit: metadata.outputLimit }),
    };
    assertRequirements(model, requirements);

    const adapter = await this.#adapter(provider.adapter);
    const credential = await this.#options.auth.getCredentials(provider.authPlugin);
    const languageModel = await adapter.createModel({
      modelId: parsed.modelId,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      credential,
    });
    const prepared = { model, languageModel, adapter: provider.adapter };
    this.#prepared.set(modelRef, prepared);
    return prepared;
  }

  prepared(modelRef: string): PreparedModel | undefined {
    return this.#prepared.get(modelRef);
  }
}
