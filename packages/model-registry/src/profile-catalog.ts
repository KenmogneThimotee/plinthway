import { PlinthwayError } from '@plinthway/shared';

import type { ModelMetadata } from './normalizer.js';

export interface BaseModelCatalog {
  get(id: string): Promise<ModelMetadata>;
}

export interface ProfileModelDeclarations {
  readonly [providerId: string]: {
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
  };
}

export class ProfileModelCatalog {
  readonly #base: BaseModelCatalog;
  readonly #providers: ProfileModelDeclarations;

  constructor(base: BaseModelCatalog, providers: ProfileModelDeclarations) {
    this.#base = base;
    this.#providers = providers;
  }

  async get(id: string): Promise<ModelMetadata> {
    const separator = id.indexOf('/');
    const providerId = separator < 0 ? '' : id.slice(0, separator);
    const modelId = separator < 0 ? '' : id.slice(separator + 1);
    const override = this.#providers[providerId]?.models[modelId];
    let base: ModelMetadata | undefined;
    try {
      base = await this.#base.get(id);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'MODEL_NOT_FOUND'
      ) {
        throw error;
      }
    }
    if (base === undefined && override === undefined) {
      throw new PlinthwayError('MODEL_NOT_FOUND', `Model ${id} was not found`, { modelId: id });
    }
    const contextLimit = override?.contextLimit ?? base?.contextLimit;
    const outputLimit = override?.outputLimit ?? base?.outputLimit;
    return {
      id,
      providerId,
      modelId,
      name: override?.name ?? base?.name ?? modelId,
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      capabilities: {
        toolCalls: override?.toolCalls ?? base?.capabilities.toolCalls ?? false,
        reasoning: override?.reasoning ?? base?.capabilities.reasoning ?? false,
        structuredOutput:
          override?.structuredOutput ?? base?.capabilities.structuredOutput ?? false,
      },
    };
  }

  async listDeclared(providerId?: string): Promise<readonly ModelMetadata[]> {
    const entries = Object.entries(this.#providers)
      .filter(([id]) => providerId === undefined || id === providerId)
      .flatMap(([id, provider]) =>
        Object.keys(provider.models).map((modelId) => `${id}/${modelId}`),
      )
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(entries.map((id) => this.get(id)));
  }
}
