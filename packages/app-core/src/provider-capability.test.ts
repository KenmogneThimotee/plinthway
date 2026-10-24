import { describe, expect, it } from 'vitest';

import type { ProviderMetadata } from '@plinthway/model-registry';
import type { ProfileProvider } from '@plinthway/profiles';
import { defaultCatalogAdapterDeclarations } from '@plinthway/llm-runtime';

import { resolveProviderCapability } from './provider-capability.js';

const registered = new Set<ProfileProvider['adapter']>([
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
  'openai-chatgpt',
]);

function resolve(
  provider: Partial<ProviderMetadata> & Pick<ProviderMetadata, 'id' | 'name'>,
  options: { configured?: ProfileProvider; credentialAvailable?: boolean } = {},
) {
  return resolveProviderCapability({
    provider: { env: [], ...provider },
    ...(options.configured === undefined ? {} : { configured: options.configured }),
    credentialAvailable: options.credentialAvailable ?? false,
    registeredAdapters: registered,
    declarations: defaultCatalogAdapterDeclarations(),
  });
}

describe('resolveProviderCapability', () => {
  it.each([
    ['@ai-sdk/openai', 'openai'],
    ['@ai-sdk/anthropic', 'anthropic'],
    ['@ai-sdk/google', 'google'],
    ['@ai-sdk/openai-compatible', 'openai-compatible'],
  ] as const)('maps %s through a registered declaration', (npm, adapter) => {
    expect(
      resolve({
        id: 'acme',
        name: 'Acme',
        npm,
        api: 'https://api.example.test/v1',
        env: ['API_KEY'],
      }).setup?.adapter,
    ).toBe(adapter);
  });

  it('reports configured providers ready only when their required credential is available', () => {
    const configured: ProfileProvider = {
      adapter: 'openai-compatible',
      baseURL: 'https://api.acme.test/v1',
      auth: { mode: 'api-key', credential: 'keyring' },
      models: {},
    };

    expect(resolve({ id: 'acme', name: 'Acme' }, { configured }).status).toBe('setup-required');
    expect(
      resolve({ id: 'acme', name: 'Acme' }, { configured, credentialAvailable: true }).status,
    ).toBe('ready');
  });

  it('supports no-auth and one-key compatible setup but rejects complex authentication', () => {
    const base = {
      id: 'acme',
      name: 'Acme',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.acme.test/v1',
    };
    expect(resolve({ ...base, env: [] }).setup?.authMode).toBe('none');
    expect(resolve({ ...base, env: ['ACME_KEY'] }).setup).toMatchObject({
      authMode: 'api-key',
      envName: 'ACME_KEY',
    });
    const complex = resolve({ ...base, env: ['CLIENT_ID', 'CLIENT_SECRET'] });
    expect(complex.status).toBe('adapter-required');
    expect(complex.reason).toContain('multiple authentication');
  });

  it('rejects insecure or missing compatible endpoints and unknown packages', () => {
    const insecure = resolve({
      id: 'acme',
      name: 'Acme',
      npm: '@ai-sdk/openai-compatible',
      api: 'http://api.acme.test/v1',
      env: ['KEY'],
    });
    expect(insecure.status).toBe('adapter-required');
    expect(insecure.reason).toContain('secure');
    expect(resolve({ id: 'acme', name: 'Acme', npm: '@community/acme' })).toMatchObject({
      status: 'adapter-required',
      packageName: '@community/acme',
    });
  });

  it('requires the mapped adapter to be registered', () => {
    const capability = resolveProviderCapability({
      provider: {
        id: 'acme',
        name: 'Acme',
        npm: '@ai-sdk/openai',
        env: ['OPENAI_API_KEY'],
      },
      credentialAvailable: false,
      registeredAdapters: new Set(),
      declarations: defaultCatalogAdapterDeclarations(),
    });
    expect(capability.status).toBe('adapter-required');
    expect(capability.reason).toContain('not registered');
  });

  it('treats a configured ChatGPT OAuth overlay as ready without a keyring API key', () => {
    expect(
      resolve(
        { id: 'chatgpt', name: 'ChatGPT subscription' },
        {
          configured: {
            adapter: 'openai-chatgpt',
            auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
            models: {},
          },
        },
      ).status,
    ).toBe('ready');
  });
});
