import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { GlobalConfig, ModelOverride } from '@plinthway/config';

import { CatalogCache } from './cache.js';
import { ModelRegistry } from './registry.js';
import { createCatalogSearchIndex } from './search.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/models',
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtures, name), 'utf8'));
}

function config(models: Record<string, ModelOverride> = {}): GlobalConfig {
  return {
    schemaVersion: 1,
    registry: { source: 'https://models.dev/api.json', cache: true, refreshIntervalHours: 24 },
    providers: {
      anthropic: {
        adapter: 'anthropic',
        authPlugin: 'anthropic-api-key',
        models,
      },
      openai: { adapter: 'openai', authPlugin: 'openai-api-key', models: {} },
    },
    mcpServers: {},
    security: { defaultToolPolicy: 'deny', allowedHttpOrigins: [] },
    keymap: {
      commandPalette: 'ctrl+p',
      submit: 'enter',
      newline: 'shift+enter',
      close: 'escape',
      cancel: 'ctrl+c',
      complete: 'tab',
    },
  };
}

function response(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers,
  });
}

async function setup(fetchMock: ReturnType<typeof vi.fn>, configured = config()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-registry-'));
  const cache = new CatalogCache(directory);
  const registry = new ModelRegistry({
    config: configured,
    cache,
    fetch: fetchMock as typeof fetch,
    now: () => 100,
    adapterSupported: (adapter) => adapter === 'anthropic',
    credentialsAvailable: (providerId) => providerId === 'anthropic',
  });
  return { cache, registry };
}

describe('ModelRegistry', () => {
  it('keeps last-known-good data when a refresh is invalid', async () => {
    const fetchMock = vi.fn();
    const { cache, registry } = await setup(fetchMock);
    await cache.commit(await fixture('valid.json'), { etag: 'v1', fetchedAt: 1 });
    fetchMock.mockResolvedValue(response(await fixture('invalid.json')));

    await expect(registry.sync()).rejects.toMatchObject({ code: 'REGISTRY_INVALID' });
    expect((await registry.get('anthropic/claude-test')).id).toBe('anthropic/claude-test');
  });

  it('uses conditional requests and handles 304 without replacing data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const { cache, registry } = await setup(fetchMock);
    const committed = await cache.commit(await fixture('valid.json'), {
      etag: 'v1',
      lastModified: 'yesterday',
      fetchedAt: 1,
    });

    await expect(registry.sync()).resolves.toMatchObject({
      changed: false,
      source: 'cache',
      fallback: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({
        headers: { 'If-Modified-Since': 'yesterday', 'If-None-Match': 'v1' },
      }),
    );
    expect((await cache.load()).metadata.sha256).toBe(committed.sha256);
  });

  it('starts offline with valid cache and fails without one', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('offline'));
    const withCache = await setup(offline);
    await withCache.cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    await expect(withCache.registry.sync()).resolves.toMatchObject({
      source: 'cache',
      fallback: true,
    });
    expect(withCache.registry.catalogStatus()).toEqual({
      source: 'cache',
      providerMetadataAvailable: true,
    });

    const withoutCache = await setup(offline);
    await expect(withoutCache.registry.sync()).rejects.toMatchObject({
      code: 'REGISTRY_UNAVAILABLE',
    });
  });

  it('falls back to cache on an unsuccessful HTTP response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const { cache, registry } = await setup(fetchMock);
    await cache.commit(await fixture('valid.json'), { fetchedAt: 1 });
    await expect(registry.sync()).resolves.toMatchObject({ source: 'cache', changed: false });
  });

  it('enforces the catalog body limit before parsing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({}, { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }),
      );
    const { registry } = await setup(fetchMock);
    await expect(registry.sync()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('aborts registry requests after fifteen seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
      const { registry } = await setup(fetchMock);
      const sync = registry.sync();
      const expectedRejection = expect(sync).rejects.toMatchObject({
        code: 'REGISTRY_UNAVAILABLE',
      });
      while (fetchMock.mock.calls.length === 0) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      await vi.advanceTimersByTimeAsync(15_000);
      await expectedRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by provider, context, and capabilities', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(await fixture('valid.json')));
    const { registry } = await setup(fetchMock);
    await registry.sync();

    expect(
      registry.list({ provider: 'anthropic', minimumContext: 100000, toolCalls: true }),
    ).toHaveLength(1);
    expect(registry.list({ structuredOutput: true }).map((model) => model.id)).toEqual([
      'openai/gpt-test',
    ]);
  });

  it('applies fully qualified overrides and reports availability independently', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(await fixture('valid.json')));
    const { registry } = await setup(
      fetchMock,
      config({ 'anthropic/claude-test': { contextLimit: 400000 } }),
    );
    await registry.sync();

    expect(await registry.get('anthropic/claude-test')).toMatchObject({ contextLimit: 400000 });
    expect(registry.resolveMetadata('openai/gpt-test')).toMatchObject({
      metadataPresent: true,
      adapterSupported: false,
      credentialsAvailable: false,
    });
    expect(registry.resolveMetadata('missing/nope')).toEqual({
      metadataPresent: false,
      adapterSupported: false,
      credentialsAvailable: false,
    });
  });

  it('exposes the activated snapshot and searches without more I/O', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(await fixture('valid.json')));
    const { cache, registry } = await setup(fetchMock);
    await registry.sync();
    fetchMock.mockClear();
    const cacheLoad = vi.spyOn(cache, 'tryLoad');

    const before = registry.snapshot();
    const result = registry.search('claude-test');

    expect(before.providers.get('anthropic')?.name).toBe('Anthropic');
    expect(result.modelRefs).toEqual(['anthropic/claude-test']);
    expect(registry.snapshot()).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheLoad).not.toHaveBeenCalled();
  });

  it('retains the prior snapshot and index when replacement index construction fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(await fixture('valid.json')))
      .mockResolvedValueOnce(response(await fixture('changed.json')));
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-registry-'));
    const createSearchIndex = vi
      .fn()
      .mockImplementationOnce(createCatalogSearchIndex)
      .mockImplementationOnce(() => {
        throw new Error('index construction failed');
      });
    const registry = new ModelRegistry({
      config: config(),
      cache: new CatalogCache(directory),
      fetch: fetchMock as typeof fetch,
      createSearchIndex,
    });
    await registry.sync();
    const before = registry.snapshot();

    await expect(registry.sync()).rejects.toThrow('index construction failed');
    expect(registry.snapshot()).toBe(before);
    expect(registry.search('claude-test').modelRefs).toEqual(['anthropic/claude-test']);
  });
});
