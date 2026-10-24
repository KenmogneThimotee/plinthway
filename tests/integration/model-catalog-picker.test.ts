import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProfileCredentialVault,
  type ChatGptAccounts,
  type Credential,
  type CredentialStore,
} from '../../packages/auth/src/index.js';
import {
  PlinthwayApplication,
  type PlinthwayApplicationServices,
} from '../../packages/app-core/src/index.js';
import type { GlobalConfig } from '../../packages/config/src/index.js';
import {
  CatalogCache,
  ModelRegistry,
  type SourceCatalog,
} from '../../packages/model-registry/src/index.js';
import { FileProfileRepository, ProfileCatalog } from '../../packages/profiles/src/index.js';
import { asSessionId } from '../../packages/shared/src/index.js';

import { searchModelCatalog, visibleModelRows } from '../../apps/cli/src/tui/model-picker.js';
import { providerConfigurationFromPrefill } from '../../apps/cli/src/tui/overlays/provider-setup.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryKeyring implements CredentialStore {
  readonly source = 'keyring' as const;
  readonly entries = new Map<string, Credential>();

  get(key: string): Promise<Credential | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  set(key: string, credential: Credential): Promise<void> {
    this.entries.set(key, credential);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

const config: GlobalConfig = {
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
};

function sourceCatalog(extraOpenAiModels = 0): SourceCatalog {
  const openAiModels = Object.fromEntries(
    Array.from({ length: extraOpenAiModels }, (_, index) => [
      `scale-${String(index).padStart(5, '0')}`,
      {
        id: `scale-${String(index).padStart(5, '0')}`,
        name: `Scale Model ${String(index).padStart(5, '0')}`,
        tool_call: true,
      },
    ]),
  );
  return {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      npm: '@ai-sdk/openai',
      env: ['OPENAI_API_KEY'],
      models: {
        current: { id: 'current', name: 'Shared Chat', tool_call: true },
        removed: { id: 'removed', name: 'Removed Later', tool_call: true },
        ...openAiModels,
      },
    },
    acme: {
      id: 'acme',
      name: 'Acme AI',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.acme.test/v1',
      env: ['ACME_KEY'],
      doc: 'https://docs.acme.test',
      models: { chat: { id: 'chat', name: 'Shared Chat', tool_call: true } },
    },
    community: {
      id: 'community',
      name: 'Community Cloud',
      npm: '@community/provider;touch /tmp/never',
      api: 'https://api.community.test/v1',
      env: ['COMMUNITY_KEY;touch /tmp/never'],
      doc: 'https://docs.community.test/%24%28never%29',
      models: { chat: { id: 'chat', name: 'Community Chat' } },
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly cache: CatalogCache;
  readonly registry: ModelRegistry;
  readonly repository: FileProfileRepository;
  readonly profiles: ProfileCatalog;
  readonly keyring: MemoryKeyring;
  readonly credentials: ProfileCredentialVault;
  readonly application: PlinthwayApplication;
  readonly fetchMock: ReturnType<typeof vi.fn>;
}

async function fixture(options: { readonly scale?: number } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-model-picker-'));
  roots.push(root);
  const cacheDirectory = path.join(root, 'cache');
  const profilesDirectory = path.join(root, 'profiles');
  await Promise.all([
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(profilesDirectory, { recursive: true }),
  ]);
  const cache = new CatalogCache(cacheDirectory);
  await cache.commit(sourceCatalog(options.scale), { fetchedAt: 1 });
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
  const registry = new ModelRegistry({
    config,
    cache,
    fetch: fetchMock as typeof fetch,
    now: () => 2,
  });
  await registry.sync();

  const repository = new FileProfileRepository(profilesDirectory);
  await repository.ensureDefaultIfEmpty();
  const profiles = new ProfileCatalog({
    repository,
    config,
    registry,
    activeStore: { get: () => Promise.resolve(undefined) },
    instructionRoots: [profilesDirectory],
    environment: {},
  });
  await profiles.configureProviderAndModel({
    profileId: 'default',
    providerId: 'openai',
    provider: {
      adapter: 'openai',
      auth: { mode: 'api-key', credential: 'keyring' },
      models: { current: { name: 'Shared Chat', toolCalls: true } },
    },
    primaryModel: 'openai/current',
  });
  await profiles.configureProvider('default', 'local', {
    adapter: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    auth: { mode: 'none' },
    models: { 'profile-only': { name: 'Profile Local', toolCalls: true } },
  });
  await profiles.configureProvider('default', 'chatgpt', {
    adapter: 'openai-chatgpt',
    auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
    models: { declared: { name: 'Declared ChatGPT', toolCalls: true } },
  });

  const keyring = new MemoryKeyring();
  const credentials = new ProfileCredentialVault(keyring);
  await credentials.setApiKey('default', 'openai', 'openai-secret');
  const chatgpt = {
    listModels: vi.fn().mockRejectedValue(new Error('account token rejected')),
  } as unknown as ChatGptAccounts;
  const application = new PlinthwayApplication({
    profiles,
    models: registry,
    credentials,
    chatgpt,
    switching: {
      initialize: vi.fn().mockResolvedValue(undefined),
      switchProfile: vi.fn().mockResolvedValue({ id: 'default' }),
      deactivate: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      newSession: vi.fn().mockImplementation(async () => ({
        id: asSessionId('session-model-picker'),
        profile: await profiles.get('default'),
        profileHash: 'integration',
        status: 'idle',
        lastSequence: 0,
        createdAt: '2026-10-19T00:00:00.000Z',
        updatedAt: '2026-10-19T00:00:00.000Z',
      })),
    },
  } as unknown as PlinthwayApplicationServices);

  return {
    root,
    cache,
    registry,
    repository,
    profiles,
    keyring,
    credentials,
    application,
    fetchMock,
  };
}

function model(catalog: Awaited<ReturnType<PlinthwayApplication['getModelCatalog']>>, id: string) {
  const found = catalog.groups
    .flatMap(({ models }) => models)
    .find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing fixture model ${id}`);
  return found;
}

describe('universal model catalog picker integration', () => {
  it('searches the complete cached catalog offline and isolates account refresh failures', async () => {
    const setup = await fixture();
    const catalog = await setup.application.getModelCatalog('default');

    expect(catalog.cached).toBe(true);
    expect(setup.fetchMock).toHaveBeenCalledOnce();
    expect(searchModelCatalog(catalog, 'shared chat').modelRefs).toEqual([
      'acme/chat',
      'openai/current',
    ]);
    expect(searchModelCatalog(catalog, 'profile local').modelRefs).toEqual(['local/profile-only']);
    expect(model(catalog, 'openai/current').execution.status).toBe('ready');
    expect(model(catalog, 'acme/chat').execution.status).toBe('setup-required');
    expect(model(catalog, 'community/chat').execution.status).toBe('adapter-required');
    expect(model(catalog, 'chatgpt/declared').execution.status).toBe('ready');

    const refreshed = await setup.application.refreshModelCatalogAccounts('default');
    expect(refreshed.groups.some(({ provider }) => provider.id === 'openai')).toBe(true);
    expect(refreshed.accountRefreshErrors.chatgpt).toContain('Account model refresh failed');
    expect(refreshed.accountRefreshErrors.chatgpt).not.toContain('account token rejected');
  });

  it('activates configured and compatible providers and survives a restart', async () => {
    const setup = await fixture();
    await setup.application.activateModelSelection({
      profileId: 'default',
      modelRef: 'local/profile-only',
    });
    expect((await setup.profiles.get('default')).model.primary).toBe('local/profile-only');

    const catalog = await setup.application.getModelCatalog('default');
    const acme = model(catalog, 'acme/chat');
    expect(acme.execution.status).toBe('setup-required');
    if (acme.execution.setup === undefined) throw new Error('Expected compatible setup metadata');
    const configuration = providerConfigurationFromPrefill({
      ...acme.execution.setup,
      model: acme,
    });
    await setup.application.activateModelSelection({
      profileId: 'default',
      modelRef: configuration.primaryModel,
      setup: {
        providerId: configuration.providerId,
        provider: configuration.provider,
        apiKey: 'acme-secret',
      },
    });

    expect((await setup.repository.get('default')).profile.model.primary).toBe('acme/chat');
    expect(setup.keyring.entries.get('profile:default:provider:acme')).toEqual({
      type: 'api-key',
      secret: 'acme-secret',
    });

    const restartedRegistry = new ModelRegistry({
      config,
      cache: setup.cache,
      fetch: vi.fn().mockRejectedValue(new TypeError('still offline')) as typeof fetch,
    });
    await restartedRegistry.sync();
    const restartedProfiles = new ProfileCatalog({
      repository: setup.repository,
      config,
      registry: restartedRegistry,
      activeStore: { get: () => Promise.resolve(undefined) },
      instructionRoots: [path.join(setup.root, 'profiles')],
      environment: {},
    });
    const restarted = new PlinthwayApplication({
      profiles: restartedProfiles,
      models: restartedRegistry,
      credentials: setup.credentials,
    } as unknown as PlinthwayApplicationServices);
    const afterRestart = await restarted.getModelCatalog('default');
    expect(model(afterRestart, 'acme/chat')).toMatchObject({
      current: true,
      execution: { status: 'ready' },
    });
  });

  it('rejects a model removed after search without changing the profile', async () => {
    const setup = await fixture();
    const beforeSearch = await setup.application.getModelCatalog('default');
    expect(model(beforeSearch, 'openai/removed').execution.status).toBe('ready');

    const next = sourceCatalog();
    delete next.openai?.models.removed;
    setup.fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(next)));
    await setup.registry.sync();

    await expect(
      setup.application.activateModelSelection({
        profileId: 'default',
        modelRef: 'openai/removed',
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    expect((await setup.profiles.get('default')).model.primary).toBe('openai/current');
  });

  it('treats package, environment, and documentation metadata as inert display text', async () => {
    const setup = await fixture();
    const catalog = await setup.application.getModelCatalog('default');
    const unsupported = model(catalog, 'community/chat');
    const spawn = vi.spyOn(childProcess, 'spawn');
    const exec = vi.spyOn(childProcess, 'exec');
    const load = vi.spyOn(
      Module as unknown as {
        _load(request: string, parent: unknown, isMain: boolean): unknown;
      },
      '_load',
    );

    const detailText = [
      unsupported.execution.packageName,
      ...unsupported.execution.authVariables,
      unsupported.execution.documentation,
    ].join('\n');
    searchModelCatalog(catalog, 'community');

    expect(detailText).toContain('@community/provider;touch /tmp/never');
    expect(detailText).toContain('COMMUNITY_KEY;touch /tmp/never');
    expect(detailText).toContain('https://docs.community.test/%24%28never%29');
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect((await setup.profiles.get('default')).model.primary).toBe('openai/current');
  });

  it('bounds terminal output with ten thousand cached models', async () => {
    const setup = await fixture({ scale: 10_000 });
    const catalog = await setup.application.getModelCatalog('default');
    const visible = visibleModelRows({
      catalog,
      state: { query: 'scale', selectedRef: 'openai/scale-00000', pageStart: 0 },
      height: 11,
      width: 80,
    });

    expect(searchModelCatalog(catalog, 'scale').modelCount).toBe(10_000);
    expect(visible.below).toBe(true);
    expect(
      visible.rows.some((row) => row.kind === 'model' && row.model.id === 'openai/scale-09999'),
    ).toBe(false);
    expect(visible.rows.length + 6).toBeLessThanOrEqual(14);
  }, 20_000);
});
