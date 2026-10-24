import { describe, expect, it, vi } from 'vitest';

import type { ChatGptAccounts, ChatGptModel, ProfileCredentialVault } from '@plinthway/auth';
import type { ProfileCatalog, ProfileProvider } from '@plinthway/profiles';
import {
  normalizeCatalog,
  sourceCatalogSchema,
  type ModelRegistry,
} from '@plinthway/model-registry';

import { PlinthwayApplication, type PlinthwayApplicationServices } from './services.js';

describe('PlinthwayApplication provider configuration', () => {
  it('validates public profile configuration before persisting a secret', async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const configureProvider = vi.fn().mockRejectedValue(new Error('invalid provider'));
    const application = new PlinthwayApplication({
      profiles: { configureProvider } as unknown as ProfileCatalog,
      credentials: { setApiKey } as unknown as ProfileCredentialVault,
    } as PlinthwayApplicationServices);

    await expect(
      application.configureProvider({
        profileId: 'default',
        providerId: 'invalid',
        apiKey: 'must-not-be-orphaned',
        provider: {
          adapter: 'openai-compatible',
          baseURL: 'https://models.example.test/v1',
          auth: { mode: 'api-key', credential: 'keyring' },
          models: {},
        },
      }),
    ).rejects.toThrow('invalid provider');
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it('lists only configured profile providers and includes profile-local subscription models', async () => {
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { model: { primary: 'openai/gpt-api' } },
          providers: {
            providers: {
              openai: {
                adapter: 'openai',
                auth: { mode: 'api-key', credential: 'keyring' },
                models: {},
              },
              acme: {
                adapter: 'openai-compatible',
                baseURL: 'https://models.acme.test/v1',
                auth: { mode: 'none' },
                models: {
                  'profile-only': { name: 'Profile Only', toolCalls: true },
                },
              },
              chatgpt: {
                adapter: 'openai-chatgpt',
                auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
                models: {},
              },
            },
          },
        }),
      } as unknown as ProfileCatalog,
      models: {
        snapshot: vi.fn().mockReturnValue(
          normalizeCatalog(
            sourceCatalogSchema.parse({
              openai: {
                id: 'openai',
                name: 'OpenAI',
                npm: '@ai-sdk/openai',
                env: ['OPENAI_API_KEY'],
                models: { 'gpt-api': { id: 'gpt-api', name: 'GPT API', tool_call: true } },
              },
              anthropic: {
                id: 'anthropic',
                name: 'Anthropic',
                npm: '@ai-sdk/anthropic',
                env: ['ANTHROPIC_API_KEY'],
                models: { 'claude-api': { id: 'claude-api', name: 'Claude API' } },
              },
            }),
          ),
        ),
        catalogStatus: vi.fn().mockReturnValue({ source: 'network' }),
      } as unknown as ModelRegistry,
      credentials: {
        status: vi.fn().mockResolvedValue(true),
      } as unknown as ProfileCredentialVault,
      chatgpt: {
        listModels: vi.fn().mockResolvedValue([{ id: 'gpt-test', name: 'GPT Test' }]),
      } as unknown as ChatGptAccounts,
    } as PlinthwayApplicationServices);

    const available = await application.listAvailableModels('default');
    expect(available.map(({ id }) => id)).toEqual([
      'acme/profile-only',
      'chatgpt/gpt-test',
      'openai/gpt-api',
    ]);
    expect(available[1]).toMatchObject({
      providerId: 'chatgpt',
      capabilities: { toolCalls: true },
    });
  });

  it('lists a connected ChatGPT subscription before it is configured in the active profile', async () => {
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { model: { primary: 'openai/gpt-api' } },
          providers: {
            providers: {
              openai: {
                adapter: 'openai',
                auth: { mode: 'api-key', credential: 'keyring' },
                models: {},
              },
            },
          },
        }),
      } as unknown as ProfileCatalog,
      models: {
        snapshot: vi.fn().mockReturnValue(
          normalizeCatalog(
            sourceCatalogSchema.parse({
              openai: {
                id: 'openai',
                name: 'OpenAI',
                npm: '@ai-sdk/openai',
                env: ['OPENAI_API_KEY'],
                models: { 'gpt-api': { id: 'gpt-api', name: 'GPT API' } },
              },
            }),
          ),
        ),
        catalogStatus: vi.fn().mockReturnValue({ source: 'network' }),
      } as unknown as ModelRegistry,
      credentials: {
        status: vi.fn().mockResolvedValue(true),
      } as unknown as ProfileCredentialVault,
      chatgpt: {
        listConnections: vi.fn().mockResolvedValue([
          {
            id: 'account-one',
            clientId: 'client-one',
            subject: 'subject-one',
            status: 'connected',
            sharing: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        listModels: vi
          .fn()
          .mockResolvedValue([{ id: 'gpt-subscription', name: 'GPT Subscription' }]),
      } as unknown as ChatGptAccounts,
    } as PlinthwayApplicationServices);

    const catalog = await application.refreshModelCatalogAccounts('default');
    const chatgpt = catalog.groups.find(({ provider }) => provider.id === 'chatgpt');

    expect(chatgpt).toMatchObject({
      provider: { id: 'chatgpt', name: 'ChatGPT subscription' },
      execution: { status: 'setup-required' },
    });
    expect(chatgpt?.models.map(({ id }) => id)).toEqual(['chatgpt/gpt-subscription']);
  });

  it('changes a ChatGPT model through its existing profile connection', async () => {
    let primary = 'chatgpt/gpt-old';
    const declared = new Set(['gpt-old']);
    const profiles = {
      getBundle: vi.fn().mockResolvedValue({
        providers: {
          providers: {
            chatgpt: {
              adapter: 'openai-chatgpt',
              auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
              models: { 'gpt-old': { name: 'GPT Old' } },
            },
          },
        },
      }),
      configureChatGptProvider: vi
        .fn()
        .mockImplementation((_profileId: string, _connectionId: string, model: ChatGptModel) => {
          declared.add(model.id);
          primary = `chatgpt/${model.id}`;
          return Promise.resolve();
        }),
      selectModels: vi.fn().mockImplementation((_profileId: string, model: string) => {
        const modelId = model.slice(model.indexOf('/') + 1);
        if (!declared.has(modelId)) throw new Error(`Model ${model} is not declared`);
        primary = model;
        return Promise.resolve();
      }),
    };
    const application = new PlinthwayApplication({
      profiles: profiles as unknown as ProfileCatalog,
      chatgpt: {
        listModels: vi.fn().mockResolvedValue([
          { id: 'gpt-old', name: 'GPT Old' },
          { id: 'gpt-new', name: 'GPT New' },
        ]),
      } as unknown as ChatGptAccounts,
    } as PlinthwayApplicationServices);

    await application.selectModels('default', 'chatgpt/gpt-new');

    expect(primary).toBe('chatgpt/gpt-new');
  });

  it('configures a ChatGPT model through the profile catalog', async () => {
    const configureChatGptProvider = vi.fn().mockResolvedValue(undefined);
    const application = new PlinthwayApplication({
      profiles: { configureChatGptProvider } as unknown as ProfileCatalog,
    } as PlinthwayApplicationServices);

    await application.configureChatGptProvider({
      profileId: 'default',
      connectionId: 'account-one',
      model: { id: 'gpt-test', name: 'GPT Test' },
    });
    expect(configureChatGptProvider).toHaveBeenCalledWith('default', 'account-one', {
      id: 'gpt-test',
      name: 'GPT Test',
    });
  });

  it('activates a configured model and returns the newly created session', async () => {
    const session = { id: 'session-new' };
    const selectModels = vi.fn().mockResolvedValue(undefined);
    const switchProfile = vi.fn().mockResolvedValue({ id: 'work' });
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { id: 'work', model: { primary: 'openai/old' } },
          providers: { providers: {} },
        }),
        selectModels,
      } as unknown as ProfileCatalog,
      switching: {
        initialize: vi.fn().mockResolvedValue({ id: 'work' }),
        switchProfile,
      },
      sessions: { newSession: vi.fn().mockResolvedValue(session) },
    } as unknown as PlinthwayApplicationServices);

    await expect(
      application.activateModelSelection({ profileId: 'work', modelRef: 'openai/new' }),
    ).resolves.toBe(session);
    expect(selectModels).toHaveBeenCalledWith('work', 'openai/new', []);
    expect(switchProfile).toHaveBeenCalledWith('work', { onBusy: 'cancel' });
  });

  it('activates an account-discovered ChatGPT model through the profile connection', async () => {
    let primary = 'chatgpt/gpt-old';
    const declared = new Set(['gpt-old']);
    const session = { id: 'session-new' };
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { id: 'work', model: { primary } },
          providers: {
            providers: {
              chatgpt: {
                adapter: 'openai-chatgpt',
                auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
                models: { 'gpt-old': { name: 'GPT Old' } },
              },
            },
          },
        }),
        configureChatGptProvider: vi
          .fn()
          .mockImplementation((_profileId: string, _connectionId: string, model: ChatGptModel) => {
            declared.add(model.id);
            primary = `chatgpt/${model.id}`;
            return Promise.resolve();
          }),
        selectModels: vi.fn().mockImplementation((_profileId: string, model: string) => {
          const modelId = model.slice(model.indexOf('/') + 1);
          if (!declared.has(modelId)) throw new Error(`Model ${model} is not declared`);
          primary = model;
          return Promise.resolve();
        }),
      } as unknown as ProfileCatalog,
      chatgpt: {
        listModels: vi.fn().mockResolvedValue([
          { id: 'gpt-old', name: 'GPT Old' },
          { id: 'gpt-new', name: 'GPT New' },
        ]),
      } as unknown as ChatGptAccounts,
      switching: {
        initialize: vi.fn().mockResolvedValue({ id: 'work' }),
        switchProfile: vi.fn().mockResolvedValue({ id: 'work' }),
      },
      sessions: { newSession: vi.fn().mockResolvedValue(session) },
    } as unknown as PlinthwayApplicationServices);

    await expect(
      application.activateModelSelection({ profileId: 'work', modelRef: 'chatgpt/gpt-new' }),
    ).resolves.toBe(session);
    expect(primary).toBe('chatgpt/gpt-new');
  });

  it('restores profile state and deletes only a newly created credential after session failure', async () => {
    const provider: ProfileProvider = {
      adapter: 'openai-compatible',
      baseURL: 'https://api.acme.test/v1',
      auth: { mode: 'api-key', credential: 'keyring' },
      models: { chat: { name: 'Chat' } },
    };
    const before = {
      profile: { id: 'work', model: { primary: 'openai/old' } },
      providers: { providers: {} },
    };
    const restoreProviderSelection = vi.fn().mockResolvedValue(undefined);
    const deleteProvider = vi.fn().mockResolvedValue(undefined);
    const switchProfile = vi.fn().mockResolvedValue({ id: 'work' });
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue(before),
        validateProviderAndModel: vi.fn().mockResolvedValue(undefined),
        configureProviderAndModel: vi.fn().mockResolvedValue(undefined),
        restoreProviderSelection,
      } as unknown as ProfileCatalog,
      credentials: {
        status: vi.fn().mockResolvedValue(false),
        setApiKey: vi.fn().mockResolvedValue(undefined),
        deleteProvider,
      } as unknown as ProfileCredentialVault,
      switching: {
        initialize: vi.fn().mockResolvedValue({ id: 'work' }),
        switchProfile,
      },
      sessions: { newSession: vi.fn().mockRejectedValue(new Error('session failed')) },
    } as unknown as PlinthwayApplicationServices);

    await expect(
      application.activateModelSelection({
        profileId: 'work',
        modelRef: 'acme/chat',
        setup: { providerId: 'acme', provider, apiKey: 'new-secret' },
      }),
    ).rejects.toThrow('session failed');

    expect(restoreProviderSelection).toHaveBeenCalledWith('work', before);
    expect(deleteProvider).toHaveBeenCalledWith('work', 'acme');
    expect(switchProfile).toHaveBeenCalledTimes(2);
  });

  it('restores a pre-existing profile credential during compensation', async () => {
    const deleteProvider = vi.fn().mockResolvedValue(undefined);
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { id: 'work', model: { primary: 'openai/old' } },
          providers: { providers: {} },
        }),
        validateProviderAndModel: vi.fn().mockResolvedValue(undefined),
        configureProviderAndModel: vi.fn().mockResolvedValue(undefined),
        restoreProviderSelection: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProfileCatalog,
      credentials: {
        status: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockResolvedValue({ type: 'api-key', secret: 'existing-secret' }),
        setApiKey,
        deleteProvider,
      } as unknown as ProfileCredentialVault,
      switching: {
        initialize: vi.fn().mockResolvedValue({ id: 'work' }),
        switchProfile: vi.fn().mockResolvedValue({ id: 'work' }),
      },
      sessions: { newSession: vi.fn().mockRejectedValue(new Error('session failed')) },
    } as unknown as PlinthwayApplicationServices);

    await expect(
      application.activateModelSelection({
        profileId: 'work',
        modelRef: 'acme/chat',
        setup: {
          providerId: 'acme',
          provider: {
            adapter: 'openai-compatible',
            baseURL: 'https://api.acme.test/v1',
            auth: { mode: 'api-key', credential: 'keyring' },
            models: { chat: { name: 'Chat' } },
          },
          apiKey: 'replacement-secret',
        },
      }),
    ).rejects.toThrow('session failed');
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(setApiKey).toHaveBeenNthCalledWith(1, 'work', 'acme', 'replacement-secret');
    expect(setApiKey).toHaveBeenNthCalledWith(2, 'work', 'acme', 'existing-secret');
  });

  it('exposes every catalog provider and isolates account refresh failures', async () => {
    const snapshot = normalizeCatalog(
      sourceCatalogSchema.parse({
        openai: {
          id: 'openai',
          name: 'OpenAI',
          npm: '@ai-sdk/openai',
          env: ['OPENAI_API_KEY'],
          models: { gpt: { id: 'gpt', name: 'GPT' } },
        },
        unsupported: {
          id: 'unsupported',
          name: 'Unsupported',
          npm: '@community/provider',
          models: { chat: { id: 'chat', name: 'Chat' } },
        },
      }),
    );
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          profile: { id: 'default', model: { primary: 'openai/gpt' } },
          providers: {
            providers: {
              openai: {
                adapter: 'openai',
                auth: { mode: 'api-key', credential: 'keyring' },
                models: {},
              },
              chatgpt: {
                adapter: 'openai-chatgpt',
                auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
                models: { 'gpt-old': { name: 'GPT Old' } },
              },
            },
          },
        }),
      } as unknown as ProfileCatalog,
      models: {
        snapshot: vi.fn().mockReturnValue(snapshot),
        catalogStatus: vi.fn().mockReturnValue({
          source: 'cache',
          providerMetadataAvailable: true,
        }),
      } as unknown as ModelRegistry,
      credentials: {
        status: vi
          .fn()
          .mockImplementation((_profileId: string, providerId: string) =>
            Promise.resolve(providerId === 'openai'),
          ),
      } as unknown as ProfileCredentialVault,
      chatgpt: {
        listModels: vi.fn().mockRejectedValue(new Error('token secret refresh failed')),
      } as unknown as ChatGptAccounts,
    } as unknown as PlinthwayApplicationServices);

    const initial = await application.getModelCatalog('default');
    expect(initial.groups.map(({ provider }) => provider.id)).toEqual([
      'chatgpt',
      'openai',
      'unsupported',
    ]);
    expect(initial.groups.find(({ provider }) => provider.id === 'openai')?.execution.status).toBe(
      'ready',
    );
    expect(
      initial.groups.find(({ provider }) => provider.id === 'unsupported')?.execution.status,
    ).toBe('adapter-required');
    expect(initial.cached).toBe(true);

    const refreshed = await application.refreshModelCatalogAccounts('default');
    expect(refreshed.groups.map(({ provider }) => provider.id)).toEqual([
      'chatgpt',
      'openai',
      'unsupported',
    ]);
    expect(refreshed.accountRefreshErrors.chatgpt).toContain('[REDACTED]');
    expect(refreshed.accountRefreshErrors.chatgpt).not.toContain('secret');
  });

  it('adds configured labels to connected and disconnected MCP statuses', async () => {
    const application = new PlinthwayApplication({
      profiles: {
        getBundle: vi.fn().mockResolvedValue({
          mcp: {
            servers: {
              docs: {
                label: 'Work Docs',
                transport: 'streamable-http',
                url: 'https://docs.example.com/mcp',
              },
              search: {
                label: 'Research Search',
                transport: 'streamable-http',
                url: 'https://search.example.com/mcp',
              },
            },
            enabled: ['docs'],
          },
        }),
      } as unknown as ProfileCatalog,
      mcp: {
        status: vi.fn().mockReturnValue([{ serverId: 'docs', state: 'ready' }]),
      },
    } as unknown as PlinthwayApplicationServices);

    await expect(application.listMcpServers('default')).resolves.toEqual([
      { serverId: 'docs', label: 'Work Docs', enabled: true, state: 'ready' },
      {
        serverId: 'search',
        label: 'Research Search',
        enabled: false,
        state: 'disconnected',
      },
    ]);
  });
});
