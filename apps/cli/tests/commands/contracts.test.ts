import { describe, expect, it, vi } from 'vitest';

import {
  asProfileId,
  asSessionId,
  PlinthwayError,
  registerRedactionSecret,
  type EffectiveProfile,
  type LLMEvent,
  type WorkProfile,
} from '@plinthway/shared';

import { runCli, type CliApplication, type CliContext } from '../../src/application.js';

function profile(): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('coding'),
    name: 'Coding',
    model: { primary: 'openai/test', fallback: [], parameters: {} },
    mcp: { enabled: [], roots: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist: true },
    generationId: 'generation-1',
    resolvedMcpServers: [],
    resolvedProviders: {},
  };
}

async function* completion(): AsyncGenerator<LLMEvent> {
  await Promise.resolve();
  yield { type: 'text-delta', text: 'hello' };
  yield { type: 'finish', reason: 'stop' };
}

function fixture(overrides: Partial<CliApplication> = {}) {
  let stdout = '';
  let stderr = '';
  const run = vi.fn().mockResolvedValue({
    session: {
      id: asSessionId('session-1'),
      profile: profile(),
      profileHash: 'hash',
      status: 'idle',
      lastSequence: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    events: completion(),
  });
  const application: CliApplication = {
    initialize: vi.fn().mockResolvedValue(profile()),
    switchProfile: vi.fn().mockResolvedValue(profile()),
    deactivateProfile: vi.fn().mockResolvedValue(undefined),
    listProfiles: vi.fn().mockResolvedValue([profile()]),
    getProfile: vi.fn().mockResolvedValue(profile()),
    validateProfile: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
    createProfile: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(undefined),
    addMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServerEnabled: vi.fn().mockResolvedValue(undefined),
    removeMcpServer: vi.fn().mockResolvedValue(undefined),
    listMcpServers: vi.fn().mockResolvedValue([]),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    exportProfile: vi.fn().mockResolvedValue({ profile: profile() as WorkProfile }),
    configureProvider: vi.fn().mockResolvedValue(undefined),
    configureChatGptProvider: vi.fn().mockResolvedValue(undefined),
    listAvailableModels: vi.fn().mockResolvedValue([]),
    signInChatGpt: vi.fn().mockResolvedValue({
      id: 'account-one',
      clientId: 'oaiapp-one',
      subject: 'user',
      email: 'user@example.com',
      status: 'connected',
      sharing: true,
      createdAt: 1,
      updatedAt: 1,
    }),
    listChatGptAccounts: vi.fn().mockResolvedValue([]),
    listChatGptModels: vi.fn().mockResolvedValue([]),
    disconnectChatGpt: vi.fn().mockResolvedValue({ revocationConfirmed: true }),
    selectModels: vi.fn().mockResolvedValue(undefined),
    setProviderApiKey: vi.fn().mockResolvedValue(undefined),
    deleteProviderCredential: vi.fn().mockResolvedValue(undefined),
    providerCredentialStatus: vi.fn().mockResolvedValue(false),
    prepareMcp: vi.fn().mockResolvedValue(undefined),
    run,
    newSession: vi.fn().mockResolvedValue({
      id: asSessionId('session-1'),
      profile: profile(),
      profileHash: 'hash',
      status: 'idle',
      lastSequence: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    resumeSession: vi.fn().mockResolvedValue({ status: 'ready', session: {} }),
    branchSession: vi.fn(),
    ...overrides,
  } as CliApplication;
  const context: CliContext = {
    application,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
    stdin: { isTTY: false } as NodeJS.ReadStream,
    env: {},
    initializeHome: vi.fn().mockResolvedValue(undefined),
  };
  return { application, context, run, stdout: () => stdout, stderr: () => stderr };
}

describe('CLI command contracts', () => {
  it('prints help and version without bootstrapping command side effects', async () => {
    const help = fixture();
    expect(await runCli(['--help'], help.context)).toBe(0);
    expect(help.stdout()).toContain('Plinthway');
    const version = fixture();
    expect(await runCli(['--version'], version.context)).toBe(0);
    expect(version.stdout()).toContain('0.1.0');
    expect(version.stderr()).toBe('');
  });

  it('emits deterministic JSON for profile list', async () => {
    const value = fixture();
    expect(await runCli(['--json', 'profile', 'list'], value.context)).toBe(0);
    expect(JSON.parse(value.stdout())).toEqual([expect.objectContaining({ id: 'coding' })]);
  });

  it('passes an explicit run profile without changing global selection', async () => {
    const value = fixture();
    expect(await runCli(['run', '--profile', 'coding', 'say hi'], value.context)).toBe(0);
    expect(value.run).toHaveBeenCalledWith(
      'say hi',
      expect.objectContaining({ profileId: 'coding' }),
    );
    expect(value.stdout()).toBe('hello\n');
  });

  it('refuses non-interactive credential login without a supplied key', async () => {
    const value = fixture();
    expect(await runCli(['auth', 'login', 'openai-api-key'], value.context)).toBe(3);
    expect(value.stderr()).toContain('CREDENTIAL_MISSING');
  });

  it('stores CLI credentials under the selected profile and provider', async () => {
    const setProviderApiKey = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ setProviderApiKey });
    expect(
      await runCli(['auth', 'login', 'openai', '--api-key', 'test-secret'], value.context),
    ).toBe(0);
    expect(setProviderApiKey).toHaveBeenCalledWith('coding', 'openai', 'test-secret');
    expect(value.stdout()).toContain('coding/openai: authenticated');
  });

  it('logs into ChatGPT without an API key and honors no-browser callback options', async () => {
    const signInChatGpt = vi.fn().mockResolvedValue({
      id: 'account-one',
      clientId: 'oaiapp-one',
      subject: 'user',
      email: 'user@example.com',
      status: 'connected',
      sharing: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const value = fixture({ signInChatGpt });

    expect(
      await runCli(['auth', 'login', 'chatgpt', '--no-browser', '--port', '2468'], value.context),
    ).toBe(0);
    expect(signInChatGpt).toHaveBeenCalledWith(
      expect.objectContaining({
        openBrowser: false,
        callbackPort: 2468,
      }),
    );
    expect(value.stdout()).toContain('ChatGPT subscription');
    expect(value.stdout()).not.toContain('id_token_hint');
  });

  it('lists ChatGPT subscription accounts as secret-free JSON', async () => {
    const listChatGptAccounts = vi.fn().mockResolvedValue([
      {
        id: 'account-one',
        clientId: 'oaiapp-one',
        subject: 'user',
        email: 'user@example.com',
        status: 'connected',
        sharing: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const value = fixture({ listChatGptAccounts });

    expect(await runCli(['--json', 'auth', 'accounts'], value.context)).toBe(0);
    expect(JSON.parse(value.stdout())).toEqual([
      expect.objectContaining({ id: 'account-one', email: 'user@example.com' }),
    ]);
    expect(value.stdout()).not.toMatch(/accessToken|refreshToken|idToken/u);
  });

  it('disconnects a selected ChatGPT account and reports unconfirmed remote revocation', async () => {
    const disconnectChatGpt = vi.fn().mockResolvedValue({ revocationConfirmed: false });
    const value = fixture({
      disconnectChatGpt,
      listChatGptAccounts: vi.fn().mockResolvedValue([
        {
          id: 'account-one',
          clientId: 'oaiapp-one',
          subject: 'user',
          status: 'connected',
          sharing: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    });

    expect(
      await runCli(['auth', 'logout', 'chatgpt', '--connection', 'account-one'], value.context),
    ).toBe(0);
    expect(disconnectChatGpt).toHaveBeenCalledWith('account-one');
    expect(value.stdout()).toContain('remote revocation was not confirmed');
  });

  it('rejects credentials for an explicit profile that does not exist', async () => {
    const setProviderApiKey = vi.fn().mockResolvedValue(undefined);
    const value = fixture({
      getProfile: vi
        .fn()
        .mockRejectedValue(
          new PlinthwayError('PROFILE_NOT_FOUND', 'Profile missing was not found'),
        ),
      setProviderApiKey,
    });
    expect(
      await runCli(
        ['auth', 'login', 'openai', '--profile', 'missing', '--api-key', 'test-secret'],
        value.context,
      ),
    ).toBe(2);
    expect(setProviderApiKey).not.toHaveBeenCalled();
  });

  it('reports preserved MCP enablement and keeps explicit profile targeting in add guidance', async () => {
    const json = fixture({
      listMcpServers: vi
        .fn()
        .mockResolvedValue([{ serverId: 'docs', enabled: true, state: 'ready' }]),
    });
    expect(
      await runCli(
        [
          '--json',
          'mcp',
          'add',
          'docs',
          '--url',
          'https://mcp.example.com/mcp',
          '--profile',
          'coding',
          '--force',
        ],
        json.context,
      ),
    ).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ serverId: 'docs', enabled: true });

    const text = fixture();
    expect(
      await runCli(
        ['mcp', 'add', 'docs', '--url', 'https://mcp.example.com/mcp', '--profile', 'coding'],
        text.context,
      ),
    ).toBe(0);
    expect(text.stdout()).toContain('mcp connect docs --profile coding');
  });

  it('derives a remote MCP server ID from its label when the positional ID is omitted', async () => {
    const addMcpServer = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ addMcpServer });

    expect(
      await runCli(
        ['mcp', 'add', '--label', '9docs', '--url', 'https://api.example.com/mcp'],
        value.context,
      ),
    ).toBe(0);
    expect(addMcpServer).toHaveBeenCalledWith(
      'coding',
      'mcp-9docs',
      expect.objectContaining({
        label: '9docs',
        transport: 'streamable-http',
        url: 'https://api.example.com/mcp',
      }),
      { replace: false },
    );
    expect(value.stdout()).toContain('mcp connect mcp-9docs --profile coding');
  });

  it('derives a remote MCP server ID from the URL when no label is supplied', async () => {
    const addMcpServer = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ addMcpServer });

    expect(
      await runCli(['mcp', 'add', '--url', 'https://api.example.com:8443/team/mcp'], value.context),
    ).toBe(0);
    expect(addMcpServer).toHaveBeenCalledWith(
      'coding',
      'api-example-com-8443-team-mcp',
      expect.any(Object),
      { replace: false },
    );
  });

  it('reports a configuration error when a URL-only MCP endpoint is malformed', async () => {
    const addMcpServer = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ addMcpServer });

    expect(await runCli(['mcp', 'add', '--url', 'not-a-url'], value.context)).toBe(2);
    expect(value.stderr()).toContain('CONFIG_INVALID: MCP server configuration is invalid');
    expect(value.stderr()).toContain('url: Invalid URL');
    expect(value.stderr()).not.toContain('INTERNAL_ERROR');
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it('requires an explicit server ID for stdio MCP configuration', async () => {
    const addMcpServer = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ addMcpServer });

    expect(await runCli(['mcp', 'add'], value.context)).toBe(2);
    expect(value.stderr()).toContain('A stdio MCP server requires an explicit server ID');
    expect(value.stderr()).not.toContain('INTERNAL_ERROR');
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it('preserves generated-ID collision protection unless force is explicit', async () => {
    const ids = new Set<string>();
    const addMcpServer = vi
      .fn()
      .mockImplementation(
        (
          _profileId: string,
          serverId: string,
          _server: unknown,
          options: { replace?: boolean },
        ) => {
          if (ids.has(serverId) && options.replace !== true) {
            return Promise.reject(
              new PlinthwayError('CONFIG_INVALID', `MCP server ${serverId} already exists`),
            );
          }
          ids.add(serverId);
          return Promise.resolve();
        },
      );
    const value = fixture({ addMcpServer });
    const command = ['mcp', 'add', '--label', 'Docs', '--url', 'https://api.example.com/mcp'];

    expect(await runCli(command, value.context)).toBe(0);
    expect(await runCli(command, value.context)).toBe(2);
    expect(value.stderr()).toContain('MCP server docs already exists');
    expect(await runCli([...command, '--force'], value.context)).toBe(0);
  });

  it('removes an MCP server from the targeted profile and refreshes the runtime', async () => {
    const removeMcpServer = vi.fn().mockResolvedValue(undefined);
    const prepareMcp = vi.fn().mockResolvedValue(undefined);
    const value = fixture({ removeMcpServer, prepareMcp });

    expect(
      await runCli(['--json', 'mcp', 'remove', 'docs', '--profile', 'coding'], value.context),
    ).toBe(0);
    expect(removeMcpServer).toHaveBeenCalledWith('coding', 'docs');
    expect(prepareMcp).toHaveBeenCalledWith('coding');
    expect(JSON.parse(value.stdout())).toEqual({
      profileId: 'coding',
      serverId: 'docs',
      removed: true,
    });
  });

  it('does not append an internal error after Commander reports invalid arguments', async () => {
    const value = fixture();

    expect(await runCli(['mcp', 'connect'], value.context)).toBe(1);
    expect(value.stderr()).toContain("missing required argument 'server'");
    expect(value.stderr()).not.toContain('INTERNAL_ERROR');
  });

  it('prints safe field-level configuration issues in text mode', async () => {
    const value = fixture({
      addMcpServer: vi.fn().mockRejectedValue(
        new PlinthwayError('CONFIG_INVALID', 'MCP server configuration is invalid', {
          issues: [{ path: 'url', message: 'MCP endpoints must use HTTP or HTTPS' }],
        }),
      ),
    });

    expect(
      await runCli(['mcp', 'add', 'docs', '--url', 'https://api.example.com/mcp'], value.context),
    ).toBe(2);
    expect(value.stderr()).toContain(
      'CONFIG_INVALID: MCP server configuration is invalid (url: MCP endpoints must use HTTP or HTTPS)',
    );
  });

  it('completes remote OAuth while explicitly connecting an MCP server', async () => {
    let authorized = false;
    const waitForCompletion = vi.fn().mockImplementation(() => {
      authorized = true;
      return Promise.resolve();
    });
    const authorize = vi.fn().mockResolvedValue({
      state: 'redirect' as const,
      authorizationUrl: 'https://issuer.example.com/authorize',
      waitForCompletion,
    });
    const value = fixture({
      mcp: { authorize } as never,
      listMcpServers: vi.fn().mockImplementation(() =>
        Promise.resolve([
          {
            serverId: 'docs',
            enabled: true,
            state: authorized ? ('ready' as const) : ('auth-required' as const),
            authorization: authorized
              ? { state: 'authorized' as const, scopes: [] }
              : { state: 'required' as const },
          },
        ]),
      ),
    });

    expect(await runCli(['mcp', 'connect', 'docs', '--profile', 'coding'], value.context)).toBe(0);

    expect(authorize).toHaveBeenCalledWith('docs');
    expect(waitForCompletion).toHaveBeenCalledOnce();
    expect(value.stdout()).toContain('docs for profile coding (ready)');
  });

  it('fails explicit connect unless the enabled server becomes ready', async () => {
    const setMcpServerEnabled = vi.fn().mockResolvedValue(undefined);
    const value = fixture({
      setMcpServerEnabled,
      listMcpServers: vi.fn().mockResolvedValue([
        {
          serverId: 'docs',
          enabled: true,
          state: 'incompatible' as const,
          lastError: {
            code: 'MCP_PROTOCOL_ERROR',
            message: 'unsafe-upstream-diagnostic',
            retryable: false,
          },
        },
      ]),
    });

    expect(
      await runCli(['--json', 'mcp', 'connect', 'docs', '--profile', 'coding'], value.context),
    ).toBe(4);
    expect(setMcpServerEnabled).toHaveBeenCalledWith('coding', 'docs', true);
    expect(JSON.parse(value.stderr())).toMatchObject({
      code: 'MCP_CONNECTION_FAILED',
      details: {
        profileId: 'coding',
        serverId: 'docs',
        state: 'incompatible',
        reason: 'MCP_PROTOCOL_ERROR',
      },
    });
    expect(value.stderr()).not.toContain('unsafe-upstream-diagnostic');
    expect(value.stdout()).toBe('');
  });

  it('exposes MCP prompt, resource, and log catalogs as stable JSON', async () => {
    const mcp = {
      listPrompts: vi.fn(() => [{ name: 'docs.summarize', serverId: 'docs' }]),
      listResources: vi.fn(() => [{ uri: 'docs://guide', name: 'Guide', serverId: 'docs' }]),
      listEvents: vi.fn(() => [
        { type: 'logging', serverId: 'docs', level: 'info', data: 'ready' },
      ]),
    };
    const prompts = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'prompts'], prompts.context)).toBe(0);
    expect(JSON.parse(prompts.stdout())).toEqual([
      expect.objectContaining({ name: 'docs.summarize', serverId: 'docs' }),
    ]);

    const resources = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'resources'], resources.context)).toBe(0);
    expect(JSON.parse(resources.stdout())).toEqual([
      expect.objectContaining({ uri: 'docs://guide', serverId: 'docs' }),
    ]);

    const logs = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'logs', 'docs'], logs.context)).toBe(0);
    expect(JSON.parse(logs.stdout())).toEqual([
      expect.objectContaining({ type: 'logging', serverId: 'docs' }),
    ]);
  });

  it('invokes MCP prompts/resources explicitly and never injects unselected content', async () => {
    const mcp = {
      getPrompt: vi.fn().mockResolvedValue({
        trusted: false,
        serverId: 'docs',
        promptName: 'docs.summarize',
        messages: [],
      }),
      readResource: vi.fn().mockResolvedValue({
        trusted: false,
        serverId: 'docs',
        uri: 'docs://guide',
        contents: [],
      }),
    };
    const prompt = fixture({ mcp: mcp as never });
    expect(
      await runCli(
        ['--json', 'mcp', 'prompt', 'docs.summarize', '--arguments', '{"style":"short"}'],
        prompt.context,
      ),
    ).toBe(0);
    expect(mcp.getPrompt).toHaveBeenCalledWith(
      'docs.summarize',
      { style: 'short' },
      expect.objectContaining({ timeoutMs: 30_000 }),
    );

    const resource = fixture({ mcp: mcp as never });
    expect(
      await runCli(['--json', 'mcp', 'resource', 'docs', 'docs://guide'], resource.context),
    ).toBe(0);
    expect(mcp.readResource).toHaveBeenCalledWith(
      'docs',
      'docs://guide',
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('lists, activates, and reads verified MCP skills explicitly', async () => {
    const skill = {
      serverId: 'docs',
      uri: 'skill://docs/review/SKILL.md',
      frontmatter: { name: 'review', description: 'Review changes' },
      resources: 'dynamic',
    } as const;
    const mcp = {
      listSkills: vi.fn(() => [skill]),
      getSkill: vi.fn().mockResolvedValue(skill),
      activateSkill: vi.fn().mockResolvedValue({
        serverId: 'docs',
        uri: skill.uri,
        manifestHash: 'hash',
        context: 'origin-labelled',
      }),
      readSkill: vi.fn().mockResolvedValue({
        serverId: 'docs',
        skillUri: skill.uri,
        uri: 'skill://docs/review/GUIDE.md',
        bytes: Buffer.from('# Guide\n'),
        verified: true,
      }),
    };

    const listed = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'skills'], listed.context)).toBe(0);
    expect(JSON.parse(listed.stdout())).toEqual([skill]);

    const activated = fixture({ mcp: mcp as never });
    expect(await runCli(['mcp', 'skill', 'activate', 'docs', skill.uri], activated.context)).toBe(
      0,
    );
    expect(mcp.activateSkill).toHaveBeenCalledWith('docs', skill.uri, { requestedBy: 'user' });

    const read = fixture({ mcp: mcp as never });
    expect(
      await runCli(['mcp', 'skill', 'read', 'docs', skill.uri, 'GUIDE.md'], read.context),
    ).toBe(0);
    expect(read.stdout()).toBe('# Guide\n\n');
  });

  it('lists and controls sandboxed MCP App sessions', async () => {
    const app = {
      serverId: 'widgets',
      toolName: 'render',
      qualifiedName: 'widgets.render',
      resourceUri: 'ui://widgets/render',
      visibility: ['app'],
    } as const;
    const session = {
      id: 'app-session-1',
      descriptor: app,
      origin: 'http://127.0.0.1:30001',
      proxyOrigin: 'http://127.0.0.1:30002',
      url: 'http://127.0.0.1:30001/#secret',
      token: 'secret',
      closed: false,
      close: vi.fn(),
      waitUntilClosed: vi.fn().mockResolvedValue(undefined),
    };
    const mcp = {
      listApps: vi.fn(() => [app]),
      openApp: vi.fn().mockResolvedValue(session),
    };

    const listed = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'apps'], listed.context)).toBe(0);
    expect(JSON.parse(listed.stdout())).toEqual([app]);

    const opened = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'app', 'open', 'widgets.render'], opened.context)).toBe(
      0,
    );
    expect(JSON.parse(opened.stdout())).toEqual({
      id: 'app-session-1',
      tool: 'widgets.render',
      url: session.url,
      origin: session.origin,
      proxyOrigin: session.proxyOrigin,
    });
    expect(mcp.openApp).toHaveBeenCalledWith('widgets.render', {
      auditSessionId: 'session-1',
    });
    expect(session.waitUntilClosed).toHaveBeenCalledWith(undefined);
  });

  it('starts and finishes MCP OAuth while preserving issuer input', async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce({
        state: 'redirect',
        authorizationUrl: 'https://issuer.example.com/authorize?state=opaque',
      })
      .mockResolvedValueOnce({ state: 'authorized' });
    const start = fixture({ mcp: { authorize } as never });
    expect(await runCli(['--json', 'mcp', 'auth', 'docs'], start.context)).toBe(0);
    expect(JSON.parse(start.stdout())).toMatchObject({ state: 'redirect' });

    const finish = fixture({ mcp: { authorize } as never });
    expect(
      await runCli(
        [
          'mcp',
          'auth',
          'docs',
          '--code',
          'callback-code',
          '--state',
          'callback-state',
          '--issuer',
          'https://issuer.example.com',
        ],
        finish.context,
      ),
    ).toBe(0);
    expect(authorize).toHaveBeenLastCalledWith('docs', {
      code: 'callback-code',
      state: 'callback-state',
      issuer: 'https://issuer.example.com',
    });
  });

  it('creates, inspects, updates, and cancels durable MCP tasks explicitly', async () => {
    const task = {
      serverId: 'reports',
      profileGenerationId: 'generation-1',
      toolName: 'reports.generate',
      reference: {
        endpointId: 'endpoint-1',
        generation: 'v2',
        taskId: 'task-1',
        originalOperation: 'tools/call',
      },
      status: 'input_required',
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:01.000Z',
    } as const;
    const mcp = {
      listTasks: vi.fn().mockResolvedValue([task]),
      startTask: vi.fn().mockResolvedValue({ kind: 'task', task }),
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue({ ...task, status: 'working' }),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    };

    const listed = fixture({ mcp: mcp as never });
    expect(await runCli(['--json', 'mcp', 'tasks'], listed.context)).toBe(0);
    const listedTasks: unknown = JSON.parse(listed.stdout());
    expect(listedTasks).toEqual([task]);

    const started = fixture({ mcp: mcp as never });
    expect(
      await runCli(
        ['--json', 'mcp', 'task', 'start', 'reports.generate', '--arguments', '{"days":7}'],
        started.context,
      ),
    ).toBe(0);
    expect(mcp.startTask).toHaveBeenCalledWith(
      'reports.generate',
      { days: 7 },
      expect.objectContaining({ timeoutMs: 30_000 }),
    );

    const updated = fixture({ mcp: mcp as never });
    expect(
      await runCli(
        [
          '--json',
          'mcp',
          'task',
          'update',
          'reports',
          'task-1',
          '--responses',
          '{"name":{"action":"accept","content":{"input":"Ada"}}}',
        ],
        updated.context,
      ),
    ).toBe(0);
    expect(mcp.updateTask).toHaveBeenCalledWith(
      'reports',
      'task-1',
      { name: { action: 'accept', content: { input: 'Ada' } } },
      expect.objectContaining({ timeoutMs: 30_000 }),
    );

    const cancelled = fixture({ mcp: mcp as never });
    expect(await runCli(['mcp', 'task', 'cancel', 'reports', 'task-1'], cancelled.context)).toBe(0);
    expect(mcp.cancelTask).toHaveBeenCalledWith(
      'reports',
      'task-1',
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('maps typed failures to stable exit codes without leaking secrets', async () => {
    const unregister = registerRedactionSecret('credential-canary');
    const value = fixture({
      getProfile: vi
        .fn()
        .mockRejectedValue(
          new PlinthwayError('PROFILE_NOT_FOUND', 'missing credential-canary profile'),
        ),
    });
    try {
      expect(await runCli(['profile', 'show', 'missing'], value.context)).toBe(2);
      expect(value.stderr()).not.toContain('credential-canary');
    } finally {
      unregister();
    }
  });
});
