import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '@plinthway/config';
import { canonicalJson, PlinthwayError, sha256 } from '@plinthway/shared';
import { z } from 'zod';

import { sourceCatalogSchema, type SourceCatalog } from './schema.js';

const cacheMetadataFields = {
  sha256: z.string().regex(/^[a-f\d]{64}$/u),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  fetchedAt: z.number(),
};

const legacyCacheMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(1).optional(),
    providerMetadataAvailable: z.literal(false).optional(),
    ...cacheMetadataFields,
  })
  .transform((value) => ({
    ...value,
    schemaVersion: 1 as const,
    providerMetadataAvailable: false as const,
  }));

const currentCacheMetadataSchema = z.strictObject({
  schemaVersion: z.literal(2),
  providerMetadataAvailable: z.literal(true),
  ...cacheMetadataFields,
});

const cacheMetadataSchema = z.union([currentCacheMetadataSchema, legacyCacheMetadataSchema]);

export interface CacheWriteMetadata {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly fetchedAt: number;
}

export type CacheMetadata = z.infer<typeof cacheMetadataSchema>;

export interface CachedCatalog {
  readonly catalog: SourceCatalog;
  readonly metadata: CacheMetadata;
}

export type AtomicFileWriter = (path: string, contents: string | Uint8Array) => Promise<void>;

function storageCorrupt(message: string, cause?: unknown): PlinthwayError {
  return new PlinthwayError(
    'STORAGE_CORRUPT',
    message,
    {},
    cause === undefined ? undefined : { cause },
  );
}

export class CatalogCache {
  readonly #directory: string;
  readonly #write: AtomicFileWriter;

  constructor(directory: string, writer: AtomicFileWriter = atomicWriteFile) {
    this.#directory = directory;
    this.#write = writer;
  }

  async #readMetadata(name: 'current' | 'previous'): Promise<CacheMetadata | undefined> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.#directory, `catalog.${name}.json`), 'utf8'),
      );
      return cacheMetadataSchema.parse(raw);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw storageCorrupt(`Catalog ${name} metadata is corrupt`, error);
    }
  }

  async #loadMetadata(metadata: CacheMetadata): Promise<CachedCatalog> {
    try {
      const contents = await readFile(
        path.join(this.#directory, `catalog.${metadata.sha256}.json`),
        'utf8',
      );
      if (sha256(contents) !== metadata.sha256) {
        throw new Error('Catalog checksum mismatch');
      }
      const raw: unknown = JSON.parse(contents);
      return { catalog: sourceCatalogSchema.parse(raw), metadata };
    } catch (error) {
      throw storageCorrupt('Catalog generation is corrupt', error);
    }
  }

  async tryLoad(): Promise<CachedCatalog | undefined> {
    let currentError: unknown;
    try {
      const metadata = await this.#readMetadata('current');
      if (metadata !== undefined) return await this.#loadMetadata(metadata);
    } catch (error) {
      currentError = error;
    }

    try {
      const previous = await this.#readMetadata('previous');
      if (previous !== undefined) return await this.#loadMetadata(previous);
    } catch (error) {
      if (currentError === undefined) currentError = error;
    }

    if (currentError instanceof Error) throw currentError;
    if (currentError !== undefined) {
      throw storageCorrupt('Catalog metadata could not be loaded', currentError);
    }
    return undefined;
  }

  async load(): Promise<CachedCatalog> {
    const cached = await this.tryLoad();
    if (cached === undefined) {
      throw new PlinthwayError('STORAGE_ERROR', 'No cached model catalog is available');
    }
    return cached;
  }

  async loadPrevious(): Promise<CachedCatalog | undefined> {
    const metadata = await this.#readMetadata('previous');
    return metadata === undefined ? undefined : this.#loadMetadata(metadata);
  }

  async touch(metadata: CacheWriteMetadata): Promise<CacheMetadata> {
    const current = await this.load();
    const updated = cacheMetadataSchema.parse({
      schemaVersion: current.metadata.schemaVersion,
      ...(current.metadata.schemaVersion === 2 ? { providerMetadataAvailable: true as const } : {}),
      sha256: current.metadata.sha256,
      ...(current.metadata.etag === undefined ? {} : { etag: current.metadata.etag }),
      ...(current.metadata.lastModified === undefined
        ? {}
        : { lastModified: current.metadata.lastModified }),
      ...metadata,
    });
    await this.#write(path.join(this.#directory, 'catalog.current.json'), canonicalJson(updated));
    return updated;
  }

  async commit(rawCatalog: unknown, metadata: CacheWriteMetadata): Promise<CacheMetadata> {
    const catalog = sourceCatalogSchema.parse(rawCatalog);
    const contents = canonicalJson(catalog);
    const digest = sha256(contents);
    const generationPath = path.join(this.#directory, `catalog.${digest}.json`);
    const nextMetadata = cacheMetadataSchema.parse({
      schemaVersion: 2,
      providerMetadataAvailable: true,
      sha256: digest,
      ...metadata,
    });

    await this.#write(generationPath, contents);
    const verifiedContents = await readFile(generationPath, 'utf8');
    if (sha256(verifiedContents) !== digest) {
      throw storageCorrupt('New catalog generation failed checksum verification');
    }
    sourceCatalogSchema.parse(JSON.parse(verifiedContents) as unknown);

    const current = await this.#readMetadata('current');
    let previous = await this.#readMetadata('previous');
    if (current !== undefined && current.sha256 !== digest) {
      await this.#write(
        path.join(this.#directory, 'catalog.previous.json'),
        canonicalJson(current),
      );
      previous = current;
    }
    await this.#write(
      path.join(this.#directory, 'catalog.current.json'),
      canonicalJson(nextMetadata),
    );
    await this.#removeStaleGenerations(nextMetadata.sha256, previous?.sha256);
    return nextMetadata;
  }

  async #removeStaleGenerations(current: string, previous: string | undefined): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch {
      return;
    }
    const keep = new Set([current, ...(previous === undefined ? [] : [previous])]);
    await Promise.all(
      entries.map(async (entry) => {
        const match = /^catalog\.([a-f\d]{64})\.json$/u.exec(entry);
        if (match?.[1] !== undefined && !keep.has(match[1])) {
          await unlink(path.join(this.#directory, entry));
        }
      }),
    );
  }
}
