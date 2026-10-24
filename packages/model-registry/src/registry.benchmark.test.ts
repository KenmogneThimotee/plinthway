import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { GlobalConfig } from '@plinthway/config';

import { CatalogCache } from './cache.js';
import { normalizeCatalog } from './normalizer.js';
import { ModelRegistry } from './registry.js';
import { sourceCatalogSchema } from './schema.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/models/valid.json',
);

describe('cached registry benchmark', () => {
  it('reports lookup latency without a timing gate', async () => {
    const catalog = sourceCatalogSchema.parse(JSON.parse(await readFile(fixture, 'utf8')));
    const models = normalizeCatalog(catalog).models;
    for (let index = 0; index < 10; index += 1) models.get('anthropic/claude-test');
    const samples: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const start = performance.now();
      expect(models.get('anthropic/claude-test')).toBeDefined();
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const p50 = samples[499] ?? 0;
    const p95 = samples[949] ?? 0;
    process.stdout.write(
      `registry lookup benchmark p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms node=${process.version} platform=${process.platform}/${process.arch}\n`,
    );
  });

  it('searches ten thousand models without network or cache I/O', async () => {
    const providers = Object.fromEntries(
      Array.from({ length: 250 }, (_, providerIndex) => {
        const start = providerIndex * 40;
        return [
          `provider-${String(providerIndex)}`,
          {
            id: `provider-${String(providerIndex)}`,
            name: `Provider ${String(providerIndex)}`,
            models: Object.fromEntries(
              Array.from({ length: 40 }, (_, offset) => {
                const modelIndex = start + offset;
                return [
                  `chat-${String(modelIndex)}`,
                  { id: `chat-${String(modelIndex)}`, name: `Chat ${String(modelIndex)}` },
                ];
              }),
            ),
          },
        ];
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(providers)));
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-registry-scale-'));
    const cache = new CatalogCache(directory);
    const registry = new ModelRegistry({
      config: {
        schemaVersion: 1,
        registry: { source: 'https://models.dev/api.json', cache: true, refreshIntervalHours: 24 },
        providers: {},
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
      } satisfies GlobalConfig,
      cache,
      fetch: fetchMock as typeof fetch,
    });
    await registry.sync();
    const before = registry.snapshot();
    fetchMock.mockClear();
    const cacheLoad = vi.spyOn(cache, 'tryLoad');

    expect(registry.search('provider-249').modelCount).toBe(40);
    expect(registry.search('chat-9999').modelRefs).toEqual(['provider-249/chat-9999']);
    expect(registry.search('reasoning').modelCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheLoad).not.toHaveBeenCalled();
    expect(registry.snapshot()).toBe(before);
  });
});
