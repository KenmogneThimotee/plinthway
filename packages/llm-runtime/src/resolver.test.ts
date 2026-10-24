import { describe, expect, it, vi } from 'vitest';

import type { Credential } from '@plinthway/auth';
import type { GlobalConfig } from '@plinthway/config';
import type { ModelMetadata } from '@plinthway/model-registry';

import type { AuthCredentialResolver, ModelCatalog, ProviderAdapterFactory } from './contracts.js';
import { ModelResolver } from './resolver.js';

const models: Record<string, ModelMetadata> = {
  'openai/gpt-test': {
    id: 'openai/gpt-test',
    providerId: 'openai',
    modelId: 'gpt-test',
    name: 'GPT Test',
    contextLimit: 128000,
    outputLimit: 8192,
    capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
  },
  'local/org/model': {
    id: 'local/org/model',
    providerId: 'local',
    modelId: 'org/model',
    name: 'Local Test',
    contextLimit: 32000,
    capabilities: { toolCalls: false, reasoning: false, structuredOutput: false },
  },
};

const catalog: ModelCatalog = {
  get(id) {
    const model = models[id];
    if (model === undefined) {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' }));
    }
    return Promise.resolve(model);
  },
};

function config(): GlobalConfig {
  return {
    schemaVersion: 1,
    registry: { source: 'https://models.dev/api.json', cache: true, refreshIntervalHours: 24 },
    providers: {
      openai: { adapter: 'openai', authPlugin: 'openai-api-key', models: {} },
      local: {
        adapter: 'openai-compatible',
        authPlugin: 'none',
        baseURL: 'http://localhost:11434/v1',
        models: {},
      },
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

function setup(options: { credential?: Credential | null; includeOpenAI?: boolean } = {}) {
  const imports = { openai: vi.fn(), compatible: vi.fn() };
  const factory =
    (spy: () => void): ProviderAdapterFactory =>
    () => {
      spy();
      return Promise.resolve({
        providerId: 'fake',
        createModel(input) {
          return Promise.resolve({ input } as never);
        },
      });
    };
  const auth: AuthCredentialResolver = {
    getCredentials() {
      const credential: Credential | null =
        options.credential === undefined
          ? { type: 'api-key', secret: 'test-key' }
          : options.credential;
      if (credential === null) {
        return Promise.reject(Object.assign(new Error('missing'), { code: 'CREDENTIAL_MISSING' }));
      }
      return Promise.resolve(credential);
    },
  };
  const resolver = new ModelResolver({
    registry: catalog,
    auth,
    config: config(),
    adapterFactories: {
      ...(options.includeOpenAI === false ? {} : { openai: factory(imports.openai) }),
      'openai-compatible': factory(imports.compatible),
    },
  });
  return { imports, resolver };
}

describe('ModelResolver', () => {
  it.each(['missing/model', 'openai/no-adapter'])('fails explicitly for %s', async (ref) => {
    const { resolver } = setup({ includeOpenAI: ref.endsWith('no-adapter') ? false : true });
    if (ref.endsWith('no-adapter')) {
      const base = models['openai/gpt-test'];
      if (base === undefined) throw new Error('test fixture is missing');
      models[ref] = { ...base, id: ref, modelId: 'no-adapter' };
    }
    const code = ref.endsWith('no-adapter') ? 'ADAPTER_UNSUPPORTED' : 'MODEL_NOT_FOUND';
    await expect(resolver.resolve(ref)).rejects.toMatchObject({ code });
    delete models['openai/no-adapter'];
  });

  it('parses the first slash, preserves configured limits, and loads only the selected adapter', async () => {
    const { imports, resolver } = setup({ credential: { type: 'none' } });
    const resolved = await resolver.resolve('local/org/model');
    expect(resolved.model).toMatchObject({
      ref: 'local/org/model',
      providerId: 'local',
      modelId: 'org/model',
      contextLimit: 32000,
    });
    expect(imports.compatible).toHaveBeenCalledOnce();
    expect(imports.openai).not.toHaveBeenCalled();
  });

  it('rejects missing credentials and unsupported required capabilities', async () => {
    await expect(
      setup({ credential: null }).resolver.resolve('openai/gpt-test'),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
    await expect(
      setup().resolver.resolve('openai/gpt-test', { reasoning: true }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('accepts no-auth local models and required tool calling when supported', async () => {
    await expect(
      setup({ credential: { type: 'none' } }).resolver.resolve('local/org/model'),
    ).resolves.toBeDefined();
    await expect(
      setup().resolver.resolve('openai/gpt-test', { toolCalls: true }),
    ).resolves.toBeDefined();
  });
});
