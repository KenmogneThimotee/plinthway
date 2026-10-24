import type { GlobalConfig, ProviderConfig } from '@plinthway/config';
import { PlinthwayError } from '@plinthway/shared';

import type { CachedCatalog, CatalogCache } from './cache.js';
import {
  normalizeCatalog,
  type CatalogSnapshot,
  type ModelMetadata,
  type ProviderModelOverrides,
} from './normalizer.js';
import {
  createCatalogSearchIndex,
  type CatalogSearchIndex,
  type CatalogSearchResult,
} from './search.js';
import { sourceCatalogSchema, type SourceCatalog } from './schema.js';

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ModelListFilter {
  readonly provider?: string;
  readonly minimumContext?: number;
  readonly toolCalls?: boolean;
  readonly reasoning?: boolean;
  readonly structuredOutput?: boolean;
}

export interface ResolvedModelMetadata {
  readonly metadata?: ModelMetadata;
  readonly metadataPresent: boolean;
  readonly adapterSupported: boolean;
  readonly credentialsAvailable: boolean;
}

export interface RegistrySyncResult {
  readonly changed: boolean;
  readonly source: 'network' | 'cache';
  readonly fallback: boolean;
  readonly modelCount: number;
}

export interface CatalogStatus {
  readonly source: 'none' | 'network' | 'cache';
  readonly providerMetadataAvailable: boolean;
}

export interface ModelRegistryOptions {
  readonly config: GlobalConfig;
  readonly cache: CatalogCache;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly adapterSupported?: (adapter: ProviderConfig['adapter']) => boolean;
  readonly credentialsAvailable?: (providerId: string) => boolean;
  readonly createSearchIndex?: (snapshot: CatalogSnapshot) => CatalogSearchIndex;
}

const EMPTY_SNAPSHOT = normalizeCatalog({});
const EMPTY_INDEX = createCatalogSearchIndex(EMPTY_SNAPSHOT);

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_CATALOG_BYTES) {
    throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Model catalog exceeds 32 MiB');
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Model catalog exceeds 32 MiB');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function unavailable(cause?: unknown): PlinthwayError {
  return new PlinthwayError(
    'REGISTRY_UNAVAILABLE',
    'The model registry is unavailable and no valid cache can be used',
    {},
    cause === undefined ? undefined : { cause },
  );
}

export class ModelRegistry {
  readonly #config: GlobalConfig;
  readonly #cache: CatalogCache;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #adapterSupported: (adapter: ProviderConfig['adapter']) => boolean;
  readonly #credentialsAvailable: (providerId: string) => boolean;
  readonly #createSearchIndex: (snapshot: CatalogSnapshot) => CatalogSearchIndex;
  #snapshot: CatalogSnapshot = EMPTY_SNAPSHOT;
  #index: CatalogSearchIndex = EMPTY_INDEX;
  #status: CatalogStatus = Object.freeze({
    source: 'none',
    providerMetadataAvailable: false,
  });

  constructor(options: ModelRegistryOptions) {
    this.#config = options.config;
    this.#cache = options.cache;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#adapterSupported = options.adapterSupported ?? (() => false);
    this.#credentialsAvailable = options.credentialsAvailable ?? (() => false);
    this.#createSearchIndex = options.createSearchIndex ?? createCatalogSearchIndex;
  }

  #overrides(): ProviderModelOverrides {
    return Object.fromEntries(
      Object.entries(this.#config.providers).map(([providerId, provider]) => [
        providerId,
        provider.models,
      ]),
    );
  }

  #activate(catalog: SourceCatalog, status: CatalogStatus): void {
    const snapshot = normalizeCatalog(catalog, this.#overrides());
    const index = this.#createSearchIndex(snapshot);
    this.#snapshot = snapshot;
    this.#index = index;
    this.#status = Object.freeze({ ...status });
  }

  async #activateCached(cached?: CachedCatalog): Promise<CachedCatalog | undefined> {
    const available = cached ?? (await this.#cache.tryLoad());
    if (available !== undefined) {
      this.#activate(available.catalog, {
        source: 'cache',
        providerMetadataAvailable: available.metadata.providerMetadataAvailable,
      });
    }
    return available;
  }

  async sync(): Promise<RegistrySyncResult> {
    let cached: CachedCatalog | undefined;
    try {
      cached = await this.#cache.tryLoad();
    } catch {
      cached = undefined;
    }

    const headers: Record<string, string> = {};
    if (cached?.metadata.etag !== undefined) headers['If-None-Match'] = cached.metadata.etag;
    if (cached?.metadata.lastModified !== undefined) {
      headers['If-Modified-Since'] = cached.metadata.lastModified;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    let response: Response;
    try {
      response = await this.#fetch(this.#config.registry.source, {
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (cached !== undefined) {
        this.#activate(cached.catalog, {
          source: 'cache',
          providerMetadataAvailable: cached.metadata.providerMetadataAvailable,
        });
        return {
          changed: false,
          source: 'cache',
          fallback: true,
          modelCount: this.#snapshot.models.size,
        };
      }
      throw unavailable(error);
    }
    clearTimeout(timeout);

    if (response.status === 304) {
      if (cached === undefined) throw unavailable();
      await this.#cache.touch({
        ...(cached.metadata.etag === undefined ? {} : { etag: cached.metadata.etag }),
        ...(cached.metadata.lastModified === undefined
          ? {}
          : { lastModified: cached.metadata.lastModified }),
        fetchedAt: this.#now(),
      });
      this.#activate(cached.catalog, {
        source: 'cache',
        providerMetadataAvailable: cached.metadata.providerMetadataAvailable,
      });
      return {
        changed: false,
        source: 'cache',
        fallback: false,
        modelCount: this.#snapshot.models.size,
      };
    }

    if (!response.ok) {
      if (cached !== undefined) {
        this.#activate(cached.catalog, {
          source: 'cache',
          providerMetadataAvailable: cached.metadata.providerMetadataAvailable,
        });
        return {
          changed: false,
          source: 'cache',
          fallback: true,
          modelCount: this.#snapshot.models.size,
        };
      }
      throw unavailable(new Error(`Registry HTTP status ${String(response.status)}`));
    }

    let rawCatalog: unknown;
    let catalog: SourceCatalog;
    try {
      rawCatalog = JSON.parse(await readLimitedBody(response)) as unknown;
      catalog = sourceCatalogSchema.parse(rawCatalog);
    } catch (error) {
      if (error instanceof PlinthwayError) throw error;
      throw new PlinthwayError(
        'REGISTRY_INVALID',
        'The model registry returned invalid data',
        {},
        {
          cause: error,
        },
      );
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    const metadata = await this.#cache.commit(rawCatalog, {
      ...(etag === null ? {} : { etag }),
      ...(lastModified === null ? {} : { lastModified }),
      fetchedAt: this.#now(),
    });
    this.#activate(catalog, { source: 'network', providerMetadataAvailable: true });
    return {
      changed: metadata.sha256 !== cached?.metadata.sha256,
      source: 'network',
      fallback: false,
      modelCount: this.#snapshot.models.size,
    };
  }

  async loadCached(): Promise<boolean> {
    return (await this.#activateCached()) !== undefined;
  }

  async get(id: string): Promise<ModelMetadata> {
    if (this.#snapshot.models.size === 0) await this.#activateCached();
    const model = this.#snapshot.models.get(id);
    if (model === undefined) {
      throw new PlinthwayError('MODEL_NOT_FOUND', `Model ${id} was not found`, { modelId: id });
    }
    return model;
  }

  list(filter: ModelListFilter = {}): readonly ModelMetadata[] {
    return [...this.#snapshot.models.values()]
      .filter((model) => filter.provider === undefined || model.providerId === filter.provider)
      .filter(
        (model) =>
          filter.minimumContext === undefined ||
          (model.contextLimit !== undefined && model.contextLimit >= filter.minimumContext),
      )
      .filter(
        (model) =>
          filter.toolCalls === undefined || model.capabilities.toolCalls === filter.toolCalls,
      )
      .filter(
        (model) =>
          filter.reasoning === undefined || model.capabilities.reasoning === filter.reasoning,
      )
      .filter(
        (model) =>
          filter.structuredOutput === undefined ||
          model.capabilities.structuredOutput === filter.structuredOutput,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolveMetadata(id: string): ResolvedModelMetadata {
    const metadata = this.#snapshot.models.get(id);
    const providerId = metadata?.providerId ?? id.split('/')[0];
    const provider = providerId === undefined ? undefined : this.#config.providers[providerId];
    return {
      ...(metadata === undefined ? {} : { metadata }),
      metadataPresent: metadata !== undefined,
      adapterSupported: provider === undefined ? false : this.#adapterSupported(provider.adapter),
      credentialsAvailable:
        providerId === undefined ? false : this.#credentialsAvailable(providerId),
    };
  }

  snapshot(): CatalogSnapshot {
    return this.#snapshot;
  }

  search(query: string): CatalogSearchResult {
    return this.#index.search(query);
  }

  catalogStatus(): CatalogStatus {
    return this.#status;
  }
}
