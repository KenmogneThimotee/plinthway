import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeCatalog } from './normalizer.js';
import { sourceCatalogSchema } from './schema.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/models/valid.json',
);

describe('normalizeCatalog', () => {
  it('uses provider/model keys for fully qualified IDs and applies exact overrides', async () => {
    const source = sourceCatalogSchema.parse(JSON.parse(await readFile(fixture, 'utf8')));
    const snapshot = normalizeCatalog(source, {
      anthropic: {
        'anthropic/claude-test': {
          name: 'Configured Claude',
          contextLimit: 300000,
          structuredOutput: true,
        },
        'claude-small': { name: 'must not match a non-qualified key' },
      },
    });

    expect(snapshot.models.get('anthropic/claude-test')).toMatchObject({
      id: 'anthropic/claude-test',
      providerId: 'anthropic',
      modelId: 'claude-test',
      name: 'Configured Claude',
      contextLimit: 300000,
      capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
    });
    expect(snapshot.models.get('anthropic/claude-small')?.name).toBe('Claude Small');
    expect(snapshot.models.get('anthropic/claude-test')).not.toHaveProperty('future_model_field');
  });

  it('retains Models.dev provider metadata in the normalized snapshot', () => {
    const snapshot = normalizeCatalog(
      sourceCatalogSchema.parse({
        acme: {
          id: 'acme',
          name: 'Acme AI',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://api.acme.test/v1',
          env: ['ACME_API_KEY'],
          doc: 'https://docs.acme.test',
          models: { chat: { id: 'chat', name: 'Acme Chat' } },
        },
      }),
    );

    expect(snapshot.providers.get('acme')).toEqual({
      id: 'acme',
      name: 'Acme AI',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.acme.test/v1',
      env: ['ACME_API_KEY'],
      doc: 'https://docs.acme.test',
    });
    expect(snapshot.models.get('acme/chat')?.providerId).toBe('acme');
  });

  it('does not expose mutable catalog maps or records', () => {
    const snapshot = normalizeCatalog(
      sourceCatalogSchema.parse({
        acme: {
          id: 'acme',
          name: 'Acme AI',
          models: { chat: { id: 'chat', name: 'Acme Chat' } },
        },
      }),
    );

    expect(() => (snapshot.providers as Map<string, unknown>).set('injected', {})).toThrow(
      TypeError,
    );
    expect(() => ((snapshot.models.get('acme/chat') as { name: string }).name = 'Changed')).toThrow(
      TypeError,
    );
  });
});
