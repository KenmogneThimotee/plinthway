import { describe, expect, it } from 'vitest';

import { normalizeCatalog } from '@plinthway/model-registry';
import { sourceCatalogSchema } from '@plinthway/model-registry';
import type { ProfileProvider } from '@plinthway/profiles';

import type { ProviderCapability } from './provider-capability.js';
import { mergeProfileModelCatalog } from './model-catalog.js';

const ready: ProviderCapability = { status: 'ready', authVariables: [] };
const setup: ProviderCapability = { status: 'setup-required', authVariables: ['ACME_KEY'] };
const unsupported: ProviderCapability = {
  status: 'adapter-required',
  authVariables: [],
  packageName: '@community/unsupported',
};

describe('mergeProfileModelCatalog', () => {
  it('merges base, profile-local, and account models by exact reference', () => {
    const base = normalizeCatalog(
      sourceCatalogSchema.parse({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          npm: '@ai-sdk/anthropic',
          env: ['KEY'],
          models: { claude: { id: 'claude', name: 'Claude' } },
        },
        openai: {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          env: ['KEY'],
          models: { gpt: { id: 'gpt', name: 'GPT catalog' } },
        },
        unsupported: {
          id: 'unsupported',
          name: 'Unsupported',
          npm: '@community/unsupported',
          models: { model: { id: 'model', name: 'Unsupported Model' } },
        },
      }),
    );
    const providers: Readonly<Record<string, ProfileProvider>> = {
      acme: {
        adapter: 'openai-compatible',
        baseURL: 'https://api.acme.test/v1',
        auth: { mode: 'none' },
        models: { local: { name: 'Local profile model' } },
      },
      openai: {
        adapter: 'openai',
        auth: { mode: 'api-key', credential: 'keyring' },
        models: { gpt: { name: 'GPT profile override', reasoning: true } },
      },
      chatgpt: {
        adapter: 'openai-chatgpt',
        auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
        models: { 'gpt-old': { name: 'GPT Old' } },
      },
    };

    const catalog = mergeProfileModelCatalog({
      base,
      providers,
      current: 'openai/gpt',
      capabilities: new Map([
        ['acme', setup],
        ['anthropic', setup],
        ['chatgpt', ready],
        ['openai', ready],
        ['unsupported', unsupported],
      ]),
      accountModels: { chatgpt: [{ id: 'gpt-live', name: 'GPT Live' }] },
      accountRefreshErrors: {},
      cached: true,
    });

    expect(catalog.groups.map((group) => group.provider.id)).toEqual([
      'acme',
      'anthropic',
      'chatgpt',
      'openai',
      'unsupported',
    ]);
    expect(
      catalog.groups.flatMap((group) => group.models).find(({ id }) => id === 'openai/gpt'),
    ).toMatchObject({ name: 'GPT profile override', current: true, execution: ready });
    expect(catalog.groups.flatMap((group) => group.models).map(({ id }) => id)).toEqual(
      expect.arrayContaining(['acme/local', 'chatgpt/gpt-old', 'chatgpt/gpt-live']),
    );
    expect(
      catalog.groups.find(({ provider }) => provider.id === 'unsupported')?.execution.status,
    ).toBe('adapter-required');
    expect(catalog.cached).toBe(true);
  });
});
