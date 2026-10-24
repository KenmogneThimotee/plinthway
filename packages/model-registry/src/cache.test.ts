import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { atomicWriteFile } from '@plinthway/config';

import { CatalogCache } from './cache.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/models',
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'));
}

describe('CatalogCache', () => {
  it('atomically pairs metadata with validated data and retains one previous generation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const cache = new CatalogCache(directory);
    const first = await cache.commit(await fixture('valid.json'), { etag: 'v1', fetchedAt: 1 });
    const second = await cache.commit(await fixture('changed.json'), { etag: 'v2', fetchedAt: 2 });
    await cache.commit(await fixture('changed.json'), { etag: 'v3', fetchedAt: 3 });

    expect((await cache.load()).metadata.sha256).toBe(second.sha256);
    expect((await cache.load()).metadata).toMatchObject({
      schemaVersion: 2,
      providerMetadataAvailable: true,
    });
    expect((await cache.loadPrevious())?.metadata.sha256).toBe(first.sha256);
    expect(
      JSON.parse(await readFile(path.join(directory, 'catalog.current.json'), 'utf8')),
    ).toMatchObject({
      sha256: second.sha256,
      etag: 'v3',
      schemaVersion: 2,
      providerMetadataAvailable: true,
    });
  });

  it('loads absent-version and version 1 pointers without advertising provider metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const cache = new CatalogCache(directory);
    const committed = await cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    const pointerPath = path.join(directory, 'catalog.current.json');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>;
    delete pointer.schemaVersion;
    delete pointer.providerMetadataAvailable;
    await writeFile(pointerPath, JSON.stringify(pointer));

    expect((await cache.load()).metadata).toMatchObject({
      schemaVersion: 1,
      providerMetadataAvailable: false,
      sha256: committed.sha256,
    });

    await writeFile(pointerPath, JSON.stringify({ ...pointer, schemaVersion: 1 }));
    expect((await cache.load()).metadata.providerMetadataAvailable).toBe(false);

    const touched = await cache.touch({ fetchedAt: 2, etag: 'legacy' });
    expect(touched).toMatchObject({
      schemaVersion: 1,
      providerMetadataAvailable: false,
      fetchedAt: 2,
      etag: 'legacy',
    });
  });

  it('rotates a fresh catalog over a legacy previous pointer with provider metadata disabled', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const cache = new CatalogCache(directory);
    const first = await cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    await writeFile(
      path.join(directory, 'catalog.previous.json'),
      JSON.stringify({
        schemaVersion: 1,
        providerMetadataAvailable: false,
        sha256: first.sha256,
        fetchedAt: 1,
      }),
    );

    const second = await cache.commit(await fixture('changed.json'), { fetchedAt: 2 });

    expect((await cache.load()).metadata.sha256).toBe(second.sha256);
  });

  it('rejects a corrupt generation instead of returning unverified data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const cache = new CatalogCache(directory);
    const committed = await cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    await writeFile(path.join(directory, `catalog.${committed.sha256}.json`), '{}');
    await expect(cache.load()).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
  });

  it('falls back to the previous validated generation when the current v2 generation is corrupt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const cache = new CatalogCache(directory);
    const first = await cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    const second = await cache.commit(await fixture('changed.json'), { fetchedAt: 2 });
    await writeFile(path.join(directory, `catalog.${second.sha256}.json`), '{}');

    const loaded = await cache.load();

    expect(loaded.metadata.sha256).toBe(first.sha256);
    expect(loaded.catalog).toEqual(await fixture('valid.json'));
  });

  it('does not expose a new generation until its metadata pointer commits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-model-cache-'));
    const stableCache = new CatalogCache(directory);
    const first = await stableCache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    const interruptedCache = new CatalogCache(directory, async (file, contents) => {
      if (file.endsWith('catalog.current.json')) throw new Error('simulated interruption');
      await atomicWriteFile(file, contents);
    });

    await expect(
      interruptedCache.commit(await fixture('changed.json'), { fetchedAt: 2 }),
    ).rejects.toThrow('simulated interruption');
    expect((await stableCache.load()).metadata.sha256).toBe(first.sha256);
  });
});
