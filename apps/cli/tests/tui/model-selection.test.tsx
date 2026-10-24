import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asProfileId, asSessionId, type ToolDescriptor, type WorkProfile } from '@plinthway/shared';

import type { CliApplication } from '../../src/application.js';
import { TuiApp } from '../../src/tui/app.js';

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

function profile(primary: string): WorkProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('default'),
    name: 'Default',
    model: { primary, fallback: [], parameters: {} },
    mcp: { enabled: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist: true },
  };
}

function inputStream(): NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  return input as unknown as NodeJS.ReadStream;
}

function outputStream(): {
  stream: NodeJS.WriteStream;
  read(): string;
  frames(): readonly string[];
} {
  const output = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = true;
  let rendered = '';
  const frames: string[] = [];
  output.on('data', (chunk: Buffer) => {
    const value = chunk.toString('utf8');
    rendered += value;
    frames.push(stripVTControlCharacters(value));
  });
  return {
    stream: output as unknown as NodeJS.WriteStream,
    read: () => stripVTControlCharacters(rendered),
    frames: () => frames,
  };
}

describe('TUI profile model selection', () => {
  it('keeps the application receiver when loading native tools during startup', async () => {
    const application = {
      toolCatalog: [] as readonly ToolDescriptor[],
      models: {
        sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }),
      },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile('openai/test')),
      prepareMcp: vi.fn().mockResolvedValue(undefined),
      listProfiles: vi.fn().mockResolvedValue([profile('openai/test')]),
      listSessions: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listTools(this: { readonly toolCatalog: readonly ToolDescriptor[] }) {
        return this.toolCatalog;
      },
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);

    await vi.waitFor(() => {
      expect(stdout.read()).toContain('profile: default');
    });
    expect(stdout.read()).not.toContain('Model catalog unavailable');
    expect(stderr.read()).toBe('');
  });

  it('loads all models from the active profile and persists a new selection', async () => {
    let primary = 'chatgpt/gpt-old';
    const activateModelSelection = vi
      .fn()
      .mockImplementation(({ modelRef }: { modelRef: string }) => {
        primary = modelRef;
        return Promise.resolve({
          id: asSessionId('session-model'),
          profile: profile(primary),
          profileHash: 'hash',
          status: 'idle',
          lastSequence: 0,
          createdAt: '2026-10-19T00:00:00.000Z',
          updatedAt: '2026-10-19T00:00:00.000Z',
        });
      });
    const application = {
      models: {
        sync: vi.fn().mockResolvedValue({
          changed: false,
          source: 'cache',
          fallback: false,
          modelCount: 1,
        }),
        list: vi.fn().mockReturnValue([
          {
            id: 'chatgpt/gpt-old',
            providerId: 'chatgpt',
            modelId: 'gpt-old',
            name: 'GPT Old',
            capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
          },
        ]),
      },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockImplementation(() => Promise.resolve(profile(primary))),
      prepareMcp: vi.fn().mockResolvedValue(undefined),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listProfiles: vi.fn().mockImplementation(() => Promise.resolve([profile(primary)])),
      listSessions: vi.fn().mockResolvedValue([]),
      getModelCatalog: vi.fn().mockImplementation(() => {
        const execution = { status: 'ready' as const, authVariables: [] };
        return Promise.resolve({
          groups: [
            {
              provider: { id: 'chatgpt', name: 'ChatGPT subscription', env: [] },
              execution,
              models: [
                {
                  id: 'chatgpt/gpt-old',
                  providerId: 'chatgpt',
                  modelId: 'gpt-old',
                  name: 'GPT Old',
                  capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
                  execution,
                  current: primary === 'chatgpt/gpt-old',
                },
                {
                  id: 'chatgpt/gpt-new',
                  providerId: 'chatgpt',
                  modelId: 'gpt-new',
                  name: 'GPT New',
                  capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
                  execution,
                  current: primary === 'chatgpt/gpt-new',
                },
              ],
            },
          ],
          accountRefreshErrors: {},
          cached: false,
        });
      }),
      refreshModelCatalogAccounts: vi
        .fn()
        .mockImplementation(() => application.getModelCatalog('default')),
      activateModelSelection,
      newSession: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: asSessionId('session-model'),
          profile: profile(primary),
          profileHash: 'hash',
          status: 'idle',
          lastSequence: 0,
          createdAt: '2026-10-19T00:00:00.000Z',
          updatedAt: '2026-10-19T00:00:00.000Z',
        }),
      ),
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);

    await vi.waitFor(() => {
      expect(stdout.read()).toContain('profile: default');
    });
    stdin.push('/model');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('/model');
    });
    stdin.push('\r');

    await vi.waitFor(() => {
      expect(stdout.read()).toContain('GPT New');
    });
    const modelFrame = stdout
      .frames()
      .findLast((frame) => frame.includes('Models') && frame.includes('GPT New'));
    expect(modelFrame).toBeDefined();
    expect(modelFrame).toContain('plinthway');
    expect(modelFrame?.split('\n').length).toBeLessThanOrEqual(30);
    stdin.push('\u001B[B');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('› GPT New');
    });
    stdin.push('\r');

    await vi.waitFor(() => {
      expect(primary).toBe('chatgpt/gpt-new');
    });
    expect(activateModelSelection).toHaveBeenCalledWith({
      profileId: 'default',
      modelRef: 'chatgpt/gpt-new',
    });
    expect(stderr.read()).toBe('');
  });

  it('opens ChatGPT account setup when selecting an unconfigured subscription model', async () => {
    const setup = {
      status: 'setup-required' as const,
      authVariables: [],
      reason: 'Select a connected ChatGPT account for this profile',
    };
    const catalog = {
      groups: [
        {
          provider: { id: 'chatgpt', name: 'ChatGPT subscription', env: [] },
          execution: setup,
          models: [
            {
              id: 'chatgpt/gpt-subscription',
              providerId: 'chatgpt',
              modelId: 'gpt-subscription',
              name: 'GPT Subscription',
              capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
              execution: setup,
              current: false,
            },
          ],
        },
      ],
      accountRefreshErrors: {},
      cached: false,
    };
    const application = {
      models: {
        sync: vi
          .fn()
          .mockResolvedValue({ changed: false, source: 'cache', fallback: false, modelCount: 1 }),
        list: vi.fn().mockReturnValue([]),
      },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile('openai/current')),
      prepareMcp: vi.fn().mockResolvedValue(undefined),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listProfiles: vi.fn().mockResolvedValue([profile('openai/current')]),
      listSessions: vi.fn().mockResolvedValue([]),
      getModelCatalog: vi.fn().mockResolvedValue(catalog),
      refreshModelCatalogAccounts: vi.fn().mockResolvedValue(catalog),
      listChatGptAccounts: vi.fn().mockResolvedValue([
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
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('profile: default');
    });

    stdin.push('/model');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('/model');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('GPT Subscription');
    });
    const beforeSelect = stdout.read().length;
    stdin.push('\r');

    await vi.waitFor(() => {
      expect(stdout.read().slice(beforeSelect)).toContain('[N] New');
    });
    expect(stdout.read().slice(beforeSelect)).not.toContain(
      'This provider does not expose a safe setup path.',
    );
    expect(stderr.read()).toBe('');
  });

  it('searches unsupported providers and preserves search while compatible setup is cancelled', async () => {
    const ready = { status: 'ready' as const, authVariables: [] };
    const adapterRequired = {
      status: 'adapter-required' as const,
      authVariables: ['COMMUNITY_KEY'],
      packageName: '@community/provider',
      documentation: 'https://docs.community.test',
      reason: 'No built-in adapter supports this provider package',
    };
    const setup = {
      status: 'setup-required' as const,
      authVariables: ['ACME_KEY'],
      setup: {
        providerId: 'acme',
        providerName: 'Acme AI',
        adapter: 'openai-compatible' as const,
        baseURL: 'https://api.acme.test/v1',
        authMode: 'api-key' as const,
        envName: 'ACME_KEY',
      },
    };
    const catalog = {
      groups: [
        {
          provider: { id: 'acme', name: 'Acme AI', env: ['ACME_KEY'] },
          execution: setup,
          models: [
            {
              id: 'acme/chat',
              providerId: 'acme',
              modelId: 'chat',
              name: 'Acme Chat',
              capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
              execution: setup,
              current: false,
            },
          ],
        },
        {
          provider: { id: 'community', name: 'Community Cloud', env: ['COMMUNITY_KEY'] },
          execution: adapterRequired,
          models: [
            {
              id: 'community/chat',
              providerId: 'community',
              modelId: 'chat',
              name: 'Community Chat',
              capabilities: { toolCalls: false, reasoning: false, structuredOutput: false },
              execution: adapterRequired,
              current: false,
            },
          ],
        },
        {
          provider: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] },
          execution: ready,
          models: [
            {
              id: 'openai/current',
              providerId: 'openai',
              modelId: 'current',
              name: 'Current',
              capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
              execution: ready,
              current: true,
            },
          ],
        },
      ],
      accountRefreshErrors: {},
      cached: false,
    };
    const session = {
      id: asSessionId('session-setup'),
      profile: profile('acme/chat'),
      profileHash: 'hash',
      status: 'idle' as const,
      lastSequence: 0,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    };
    const activateModelSelection = vi.fn().mockResolvedValue(session);
    const application = {
      models: {
        sync: vi
          .fn()
          .mockResolvedValue({ changed: false, source: 'cache', fallback: false, modelCount: 3 }),
        list: vi.fn().mockReturnValue([]),
      },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile('openai/current')),
      prepareMcp: vi.fn().mockResolvedValue(undefined),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listProfiles: vi.fn().mockResolvedValue([profile('openai/current')]),
      listSessions: vi.fn().mockResolvedValue([]),
      getModelCatalog: vi.fn().mockResolvedValue(catalog),
      refreshModelCatalogAccounts: vi.fn().mockResolvedValue(catalog),
      activateModelSelection,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('profile: default');
    });

    stdin.push('/model');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('/model');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('Community Cloud');
    });
    stdin.push('community');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('Search: community');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('@community/provider');
    });
    expect(activateModelSelection).not.toHaveBeenCalled();

    const beforeClear = stdout.read().length;
    stdin.push('\u0015');
    await vi.waitFor(() => {
      expect(stdout.read().slice(beforeClear)).toContain('Search:');
    });
    stdin.push('acme');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('Search: acme');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('ACME_KEY:');
    });
    const beforeCancel = stdout.read().length;
    stdin.push('\u001B');
    await vi.waitFor(() => {
      expect(stdout.read().slice(beforeCancel)).toContain('Search: acme');
    });
    const beforeReopen = stdout.read().length;
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read().slice(beforeReopen)).toContain('ACME_KEY:');
    });
    stdin.push('secret-key');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('ACME_KEY: **********');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(activateModelSelection).toHaveBeenCalled();
    });
    expect(activateModelSelection).toHaveBeenCalledWith({
      profileId: 'default',
      modelRef: 'acme/chat',
      setup: {
        providerId: 'acme',
        provider: {
          adapter: 'openai-compatible',
          baseURL: 'https://api.acme.test/v1',
          auth: { mode: 'api-key', credential: 'keyring' },
          models: {
            chat: {
              name: 'Acme Chat',
              toolCalls: true,
              reasoning: false,
              structuredOutput: true,
            },
          },
        },
        apiKey: 'secret-key',
      },
    });
    expect(stderr.read()).toBe('');
  });
});
