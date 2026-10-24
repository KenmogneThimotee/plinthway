import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sourceCatalogSchema } from './schema.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/models',
);

describe('sourceCatalogSchema', () => {
  it('accepts current required fields and tolerates unknown future fields', async () => {
    const value: unknown = JSON.parse(await readFile(path.join(fixtures, 'valid.json'), 'utf8'));
    expect(sourceCatalogSchema.parse(value)).toBeDefined();
  });

  it('rejects malformed required model fields', async () => {
    const value: unknown = JSON.parse(await readFile(path.join(fixtures, 'invalid.json'), 'utf8'));
    expect(() => sourceCatalogSchema.parse(value)).toThrow();
  });

  it('rejects malformed typed provider metadata', () => {
    expect(() =>
      sourceCatalogSchema.parse({
        acme: {
          id: 'acme',
          name: 'Acme',
          npm: '',
          api: 'not a url',
          env: [''],
          doc: 'also not a url',
          models: {},
        },
      }),
    ).toThrow();
  });

  it('defaults absent provider authentication variables to an empty list', () => {
    const catalog = sourceCatalogSchema.parse({
      local: { id: 'local', name: 'Local', models: {} },
    });

    expect(catalog.local?.env).toEqual([]);
  });

  it('retains templated endpoint metadata for capability resolution', () => {
    const catalog = sourceCatalogSchema.parse({
      neon: {
        id: 'neon',
        name: 'Neon',
        npm: '@ai-sdk/openai-compatible',
        api: '${NEON_AI_GATEWAY_BASE_URL}/v1',
        env: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
        doc: 'https://neon.com/docs',
        models: { chat: { id: 'chat', name: 'Chat' } },
      },
    });

    expect(catalog.neon?.api).toBe('${NEON_AI_GATEWAY_BASE_URL}/v1');
  });
});
