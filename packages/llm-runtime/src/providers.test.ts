import { describe, expect, it, vi } from 'vitest';

import type { Credential } from '@plinthway/auth';

import { anthropicAdapterFactory } from './providers/anthropic.js';
import { googleAdapterFactory } from './providers/google.js';
import {
  openAICompatibleAdapterFactory,
  originLockedFetch,
} from './providers/openai-compatible.js';
import { openAIAdapterFactory } from './providers/openai.js';
import {
  createDefaultAdapterFactories,
  defaultCatalogAdapterDeclarations,
} from './providers/index.js';

describe('catalog adapter declarations', () => {
  it('only advertises adapters backed by a built-in factory', () => {
    const factories = createDefaultAdapterFactories();
    expect(defaultCatalogAdapterDeclarations().map(({ adapter }) => adapter)).toEqual([
      'openai',
      'anthropic',
      'google',
      'openai-compatible',
    ]);
    for (const declaration of defaultCatalogAdapterDeclarations()) {
      expect(factories[declaration.adapter]).toBeTypeOf('function');
    }
  });
});

describe.each([
  ['openai', openAIAdapterFactory, 'createOpenAI'],
  ['anthropic', anthropicAdapterFactory, 'createAnthropic'],
  ['google', googleAdapterFactory, 'createGoogleGenerativeAI'],
] as const)('%s adapter factory', (_name, makeFactory, exportName) => {
  it('imports lazily and passes the API key explicitly', async () => {
    const model = { model: true };
    const provider = vi.fn(() => model);
    const create = vi.fn(() => provider);
    const importer = vi.fn(() => Promise.resolve({ [exportName]: create }));
    const factory = makeFactory(importer as never);
    expect(importer).not.toHaveBeenCalled();
    const adapter = await factory();
    await expect(
      adapter.createModel({
        modelId: 'test-model',
        credential: { type: 'api-key', secret: 'provider-key' },
      }),
    ).resolves.toBe(model);
    expect(importer).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'provider-key' }));
  });
});

describe('openai-compatible adapter factory', () => {
  it('requires a secure/loopback base URL and does not require local credentials', async () => {
    const model = { model: true };
    const provider = vi.fn(() => model);
    const create = vi.fn(() => provider);
    const factory = openAICompatibleAdapterFactory(
      (() => Promise.resolve({ createOpenAICompatible: create })) as never,
      () => Promise.resolve(new Response(null, { status: 204 })),
    );
    const adapter = await factory();
    const credential: Credential = { type: 'none' };
    await expect(
      adapter.createModel({
        modelId: 'local-model',
        baseURL: 'http://localhost:11434/v1',
        credential,
      }),
    ).resolves.toBe(model);
    await expect(adapter.createModel({ modelId: 'local-model', credential })).rejects.toMatchObject(
      { code: 'ADAPTER_UNSUPPORTED' },
    );
  });

  it('blocks cross-origin requests and redirects before credentials can escape', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
      ),
    );
    const locked = originLockedFetch(new URL('http://localhost:11434/v1'), fetchMock);
    await expect(locked('https://elsewhere.example/v1/chat')).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(locked('http://localhost:11434/v1/chat')).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
