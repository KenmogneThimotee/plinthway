import { describe, expect, it, vi } from 'vitest';

import type { Credential } from '@plinthway/auth';
import type { ModelMetadata } from '@plinthway/model-registry';

import type {
  ProfileCredentialResolver,
  ProviderAdapter,
  ProviderAdapterFactory,
} from './contracts.js';
import { ProfileModelResolver } from './profile-resolver.js';

const metadata: ModelMetadata = {
  id: 'custom/chat-model',
  providerId: 'custom',
  modelId: 'chat-model',
  name: 'Chat model',
  capabilities: { toolCalls: false, reasoning: false, structuredOutput: false },
};

describe('ProfileModelResolver', () => {
  it('binds the profile provider endpoint and profile-scoped credential', async () => {
    const createModel = vi.fn<ProviderAdapter['createModel']>(() => Promise.resolve({} as never));
    const factory: ProviderAdapterFactory = () =>
      Promise.resolve({ providerId: 'custom', createModel });
    const get = vi.fn<ProfileCredentialResolver['get']>(() =>
      Promise.resolve({ type: 'api-key', secret: 'profile-key' } satisfies Credential),
    );
    const credentials: ProfileCredentialResolver = { get };
    const resolver = new ProfileModelResolver({
      registry: { get: () => Promise.resolve(metadata) },
      credentials,
      adapterFactories: { 'openai-compatible': factory },
    });

    const prepared = await resolver.resolve(
      'custom/chat-model',
      {},
      {
        profileId: 'coding',
        providers: {
          custom: {
            adapter: 'openai-compatible',
            baseURL: 'https://models.example.test/v1',
            auth: { mode: 'api-key', credential: 'keyring' },
            models: {},
          },
        },
      },
    );

    expect(createModel).toHaveBeenCalledWith({
      modelId: 'chat-model',
      baseURL: 'https://models.example.test/v1',
      credential: { type: 'api-key', secret: 'profile-key' },
    });
    expect(prepared.model.bindingId).toMatch(/^profile:/u);
    expect(get).toHaveBeenCalledWith('coding', 'custom');
    const bindingId = prepared.model.bindingId;
    if (bindingId === undefined) throw new Error('Expected a profile binding ID');
    expect(resolver.prepared(bindingId)).toBe(prepared);
  });

  it('reports a missing profile provider before loading an adapter', async () => {
    const resolver = new ProfileModelResolver({
      registry: { get: () => Promise.resolve(metadata) },
      credentials: { get: () => Promise.reject(new Error('must not read credentials')) },
      adapterFactories: {},
    });

    await expect(
      resolver.resolve('custom/chat-model', {}, { profileId: 'coding', providers: {} }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('passes an OAuth connection to the ChatGPT adapter without reading API-key credentials', async () => {
    const createModel = vi.fn<ProviderAdapter['createModel']>(() => Promise.resolve({} as never));
    const get = vi.fn<ProfileCredentialResolver['get']>();
    const resolver = new ProfileModelResolver({
      registry: {
        get: () => Promise.reject(Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' })),
      },
      credentials: { get },
      adapterFactories: {
        'openai-chatgpt': () => Promise.resolve({ providerId: 'chatgpt', createModel }),
      },
    });

    await resolver.resolve(
      'chatgpt/gpt-test',
      {},
      {
        profileId: 'coding',
        providers: {
          chatgpt: {
            adapter: 'openai-chatgpt',
            auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
            models: { 'gpt-test': { name: 'GPT Test', toolCalls: true } },
          },
        },
      },
    );
    expect(createModel).toHaveBeenCalledWith({
      modelId: 'gpt-test',
      credential: { type: 'none' },
      connectionId: 'account-one',
    });
    expect(get).not.toHaveBeenCalled();
  });
});
