import { describe, expect, it } from 'vitest';

import { normalizeCatalog } from './normalizer.js';
import { createCatalogSearchIndex } from './search.js';
import { sourceCatalogSchema } from './schema.js';

function snapshot() {
  return normalizeCatalog(
    sourceCatalogSchema.parse({
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          claude: { id: 'claude', name: 'Claude' },
          mistral: { id: 'mistral', name: 'Mistrál Large' },
        },
      },
      bedrock: {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        models: {
          opus: { id: 'opus', name: 'Claude Opus' },
        },
      },
      acme: {
        id: 'acme',
        name: 'Acme Cloud',
        models: {
          chat: { id: 'chat', name: 'Shared Chat' },
          coder: { id: 'coder', name: 'Fast Coder' },
        },
      },
      zeta: {
        id: 'zeta',
        name: 'Zeta',
        models: {
          chat: { id: 'chat', name: 'Shared Chat' },
        },
      },
    }),
  );
}

describe('createCatalogSearchIndex', () => {
  it('returns the empty query as alphabetically grouped providers and models', () => {
    const result = createCatalogSearchIndex(snapshot()).search('');

    expect(result.groups.map((group) => group.provider.id)).toEqual([
      'acme',
      'bedrock',
      'anthropic',
      'zeta',
    ]);
    expect(result.groups[0]?.models.map((model) => model.id)).toEqual(['acme/coder', 'acme/chat']);
    expect(result).toMatchObject({ providerCount: 4, modelCount: 6 });
  });

  it('ranks exact references before prefixes, tokens, and substrings', () => {
    const index = createCatalogSearchIndex(snapshot());

    expect(index.search('acme/chat').modelRefs[0]).toBe('acme/chat');
    expect(index.search('claude').groups.map((group) => group.provider.id)).toEqual([
      'anthropic',
      'bedrock',
    ]);
    expect(index.search('code').modelRefs).toEqual(['acme/coder']);
  });

  it('matches provider and model terms together and keeps duplicate names distinct', () => {
    const index = createCatalogSearchIndex(snapshot());

    expect(index.search('acme chat').modelRefs).toEqual(['acme/chat']);
    expect(index.search('shared chat').modelRefs).toEqual(['acme/chat', 'zeta/chat']);
  });

  it('uses Unicode-safe case folding and returns a stable no-results shape', () => {
    const index = createCatalogSearchIndex(snapshot());

    expect(index.search('MISTRÁL').modelRefs).toEqual(['anthropic/mistral']);
    expect(index.search('does-not-exist')).toEqual({
      groups: [],
      modelRefs: [],
      providerCount: 0,
      modelCount: 0,
    });
  });
});
