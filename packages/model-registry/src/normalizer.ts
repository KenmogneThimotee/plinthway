import type { ModelOverride } from '@plinthway/config';

import type { SourceCatalog } from './schema.js';

export interface ModelMetadata {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly capabilities: {
    readonly toolCalls: boolean;
    readonly reasoning: boolean;
    readonly structuredOutput: boolean;
  };
}

export interface ProviderMetadata {
  readonly id: string;
  readonly name: string;
  readonly npm?: string;
  readonly api?: string;
  readonly env: readonly string[];
  readonly doc?: string;
}

export interface CatalogSnapshot {
  readonly providers: ReadonlyMap<string, ProviderMetadata>;
  readonly models: ReadonlyMap<string, ModelMetadata>;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #source: ReadonlyMap<K, V>;

  constructor(source: ReadonlyMap<K, V>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number {
    return this.#source.size;
  }

  get(key: K): V | undefined {
    return this.#source.get(key);
  }

  has(key: K): boolean {
    return this.#source.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#source.entries();
  }

  keys(): MapIterator<K> {
    return this.#source.keys();
  }

  values(): MapIterator<V> {
    return this.#source.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#source.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

export type ProviderModelOverrides = Readonly<
  Record<string, Readonly<Record<string, ModelOverride>>>
>;

export function normalizeCatalog(
  catalog: SourceCatalog,
  overrides: ProviderModelOverrides = {},
): CatalogSnapshot {
  const providers = new Map<string, ProviderMetadata>();
  const models = new Map<string, ModelMetadata>();

  for (const [providerId, provider] of Object.entries(catalog)) {
    providers.set(
      providerId,
      Object.freeze({
        id: providerId,
        name: provider.name,
        ...(provider.npm === undefined ? {} : { npm: provider.npm }),
        ...(provider.api === undefined ? {} : { api: provider.api }),
        env: Object.freeze([...provider.env]),
        ...(provider.doc === undefined ? {} : { doc: provider.doc }),
      }),
    );
    for (const [modelId, source] of Object.entries(provider.models)) {
      const id = `${providerId}/${modelId}`;
      const override = overrides[providerId]?.[id];
      const contextLimit = override?.contextLimit ?? source.limit?.context;
      const outputLimit = override?.outputLimit ?? source.limit?.output;
      models.set(
        id,
        Object.freeze({
          id,
          providerId,
          modelId,
          name: override?.name ?? source.name,
          ...(contextLimit === undefined ? {} : { contextLimit }),
          ...(outputLimit === undefined ? {} : { outputLimit }),
          capabilities: Object.freeze({
            toolCalls: override?.toolCalls ?? source.tool_call ?? false,
            reasoning: override?.reasoning ?? source.reasoning ?? false,
            structuredOutput: override?.structuredOutput ?? source.structured_output ?? false,
          }),
        }),
      );
    }
  }

  return Object.freeze({
    providers: new ImmutableMap(providers),
    models: new ImmutableMap(models),
  });
}
