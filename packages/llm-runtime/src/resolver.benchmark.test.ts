import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import type { GlobalConfig } from '@plinthway/config';

import { ModelResolver } from './resolver.js';

const config: GlobalConfig = {
  schemaVersion: 1,
  registry: { source: 'https://models.dev/api.json', cache: true, refreshIntervalHours: 24 },
  providers: {
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

describe('model resolution benchmark', () => {
  it('reports cached-boundary latency without a timing gate', async () => {
    const resolver = new ModelResolver({
      config,
      registry: {
        get() {
          return Promise.resolve({
            id: 'openai/gpt-test',
            providerId: 'openai',
            modelId: 'gpt-test',
            name: 'GPT Test',
            contextLimit: 128000,
            capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
          });
        },
      },
      auth: {
        getCredentials() {
          return Promise.resolve({ type: 'api-key' as const, secret: 'benchmark-key' });
        },
      },
      adapterFactories: {
        openai: () =>
          Promise.resolve({
            providerId: 'openai',
            createModel() {
              return Promise.resolve({ specificationVersion: 'v3' } as never);
            },
          }),
      },
    });
    for (let index = 0; index < 10; index += 1) await resolver.resolve('openai/gpt-test');
    const samples: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const start = performance.now();
      expect(await resolver.resolve('openai/gpt-test')).toBeDefined();
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    process.stdout.write(
      `model resolution benchmark p50=${String(samples[499]?.toFixed(4))}ms p95=${String(samples[949]?.toFixed(4))}ms node=${process.version} platform=${process.platform}/${process.arch}\n`,
    );
  });
});
