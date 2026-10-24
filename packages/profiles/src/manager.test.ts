import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asProfileId } from '@plinthway/shared';

import { ProfileCatalog } from './manager.js';
import { FileProfileRepository } from './repository.js';
import {
  createProfileLayout,
  FakeRegistry,
  globalConfig,
  MemoryActiveProfileStore,
  profile,
} from './test-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function catalog(): Promise<{
  readonly catalog: ProfileCatalog;
  readonly active: MemoryActiveProfileStore;
  readonly repository: FileProfileRepository;
  readonly root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-catalog-'));
  roots.push(root);
  const layout = await createProfileLayout(root);
  const repository = new FileProfileRepository(layout.profiles);
  const active = new MemoryActiveProfileStore();
  return {
    root,
    repository,
    active,
    catalog: new ProfileCatalog({
      repository,
      config: globalConfig(),
      registry: new FakeRegistry(),
      activeStore: active,
      instructionRoots: [layout.instructions, layout.profiles],
      environment: {},
    }),
  };
}

describe('ProfileCatalog', () => {
  it('keeps subscription models discovered through the same profile connection', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await fixture.catalog.configureChatGptProvider('default', 'account-one', {
      id: 'gpt-old',
      name: 'GPT Old',
    });
    await fixture.catalog.configureChatGptProvider('default', 'account-one', {
      id: 'gpt-new',
      name: 'GPT New',
    });

    const bundle = await fixture.catalog.getBundle('default');
    expect(Object.keys(bundle.providers.providers.chatgpt?.models ?? {}).sort()).toEqual([
      'gpt-new',
      'gpt-old',
    ]);
    expect(bundle.profile.model.primary).toBe('chatgpt/gpt-new');
  });

  it('configures a provider and primary model entirely inside the profile bundle', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await fixture.catalog.configureProvider('default', 'acme', {
      adapter: 'openai-compatible',
      baseURL: 'https://models.acme.test/v1',
      auth: { mode: 'api-key', credential: 'keyring' },
      models: {
        'chat-pro': { name: 'Chat Pro', toolCalls: true, structuredOutput: true },
      },
    });
    await fixture.catalog.selectModels('default', 'acme/chat-pro');

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.providers.providers.acme).toMatchObject({
      adapter: 'openai-compatible',
      baseURL: 'https://models.acme.test/v1',
    });
    expect(bundle.profile.model.primary).toBe('acme/chat-pro');
    await fixture.catalog.update('default', {
      ...bundle.profile,
      description: 'Uses the profile-local provider',
    });
    await expect(fixture.catalog.validate(bundle.profile)).resolves.toMatchObject({ valid: true });
    await expect(fixture.catalog.resolve('default')).resolves.toMatchObject({
      model: { primary: 'acme/chat-pro' },
      resolvedProviders: { acme: { adapter: 'openai-compatible' } },
    });
  });

  it('validates and commits a provider binding with its primary model together', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await fixture.catalog.configureProviderAndModel({
      profileId: 'default',
      providerId: 'acme',
      provider: {
        adapter: 'openai-compatible',
        baseURL: 'https://models.acme.test/v1',
        auth: { mode: 'none' },
        models: { chat: { name: 'Chat' } },
      },
      primaryModel: 'acme/chat',
    });

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.providers.providers.acme?.adapter).toBe('openai-compatible');
    expect(bundle.profile.model.primary).toBe('acme/chat');
  });

  it('does not mutate either file when the combined proposal is invalid', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const before = await fixture.catalog.getBundle('default');

    await expect(
      fixture.catalog.configureProviderAndModel({
        profileId: 'default',
        providerId: 'acme',
        provider: {
          adapter: 'openai-compatible',
          baseURL: 'https://models.acme.test/v1',
          auth: { mode: 'none' },
          models: {},
        },
        primaryModel: 'acme/missing',
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });

    const after = await fixture.catalog.getBundle('default');
    expect(after.providers).toEqual(before.providers);
    expect(after.profile).toEqual(before.profile);
  });

  it('stores new MCP servers without enabling them', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await fixture.catalog.addMcpServer('default', 'docs', {
      label: 'Documentation',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      auth: { mode: 'oauth', scopes: [] },
      extensions: {
        tasks: false,
        skills: false,
        apps: false,
        oauthClientCredentials: false,
        enterpriseManagedAuth: false,
      },
    });

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.enabled).toEqual([]);
    expect(bundle.mcp.servers.docs?.label).toBe('Documentation');
    expect(bundle.profile.mcp?.enabled).toEqual([]);
    expect(bundle.profile.tools.rules).toContainEqual({ tool: 'docs.*', action: 'ask' });
  });

  it.each(['filesystem', 'shell'])('rejects the reserved %s MCP server id', async (serverId) => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await expect(
      fixture.catalog.addMcpServer('default', serverId, {
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: { mode: 'none' },
        extensions: {
          tasks: false,
          skills: false,
          apps: false,
          oauthClientCredentials: false,
          enterpriseManagedAuth: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('persistently enables and disables configured MCP servers idempotently', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const remote = (url: string) => ({
      transport: 'streamable-http' as const,
      url,
      auth: { mode: 'oauth' as const, scopes: [] },
      extensions: {
        tasks: false,
        skills: false,
        apps: false,
        oauthClientCredentials: false,
        enterpriseManagedAuth: false,
      },
    });
    await fixture.catalog.addMcpServer('default', 'docs', remote('https://docs.example.com/mcp'));
    await fixture.catalog.addMcpServer(
      'default',
      'search',
      remote('https://search.example.com/mcp'),
    );

    await fixture.catalog.setMcpServerEnabled('default', 'docs', true);
    await fixture.catalog.setMcpServerEnabled('default', 'docs', true);
    await fixture.catalog.setMcpServerEnabled('default', 'search', true);
    await fixture.catalog.setMcpServerEnabled('default', 'docs', false);
    await fixture.catalog.setMcpServerEnabled('default', 'docs', false);

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.enabled).toEqual(['search']);
    expect(bundle.profile.mcp?.enabled).toEqual(['search']);
    expect(bundle.profile.tools.rules).toEqual(
      expect.arrayContaining([
        { tool: 'docs.*', action: 'ask' },
        { tool: 'search.*', action: 'ask' },
      ]),
    );
  });

  it('rejects enabling an MCP server that is not configured', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await expect(
      fixture.catalog.setMcpServerEnabled('default', 'ghost', true),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('removes an MCP server from configuration, enablement, and tool policy', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const remote = (url: string) => ({
      transport: 'streamable-http' as const,
      url,
      auth: { mode: 'none' as const },
      extensions: {
        tasks: false,
        skills: false,
        apps: false,
        oauthClientCredentials: false,
        enterpriseManagedAuth: false,
      },
    });
    await fixture.catalog.addMcpServer('default', 'docs', remote('https://docs.example.com/mcp'));
    await fixture.catalog.addMcpServer(
      'default',
      'search',
      remote('https://search.example.com/mcp'),
    );
    await fixture.catalog.setMcpServerEnabled('default', 'docs', true);
    await fixture.catalog.setMcpServerEnabled('default', 'search', true);
    const configured = await fixture.catalog.getBundle('default');
    await fixture.catalog.update('default', {
      ...configured.profile,
      tools: {
        ...configured.profile.tools,
        rules: [...configured.profile.tools.rules, { tool: 'docs.read', action: 'allow' }],
      },
    });

    await expect(
      Promise.resolve().then(() =>
        (
          fixture.catalog as ProfileCatalog & {
            removeMcpServer(profileId: string, serverId: string): Promise<void>;
          }
        ).removeMcpServer('default', 'docs'),
      ),
    ).resolves.toBeUndefined();

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.servers).not.toHaveProperty('docs');
    expect(bundle.mcp.servers).toHaveProperty('search');
    expect(bundle.mcp.enabled).toEqual(['search']);
    expect(bundle.profile.mcp?.enabled).toEqual(['search']);
    expect(bundle.profile.tools.rules).toContainEqual({ tool: 'search.*', action: 'ask' });
    expect(bundle.profile.tools.rules.filter((rule) => rule.tool.startsWith('docs.'))).toEqual([]);
  });

  it('rejects removing an MCP server that is not configured', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();

    await expect(
      Promise.resolve().then(() =>
        (
          fixture.catalog as ProfileCatalog & {
            removeMcpServer(profileId: string, serverId: string): Promise<void>;
          }
        ).removeMcpServer('default', 'ghost'),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('keeps an already-enabled MCP server enabled when its configuration is replaced', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const server = (url: string) => ({
      transport: 'streamable-http' as const,
      url,
      auth: { mode: 'oauth' as const, scopes: [] },
      extensions: {
        tasks: false,
        skills: false,
        apps: false,
        oauthClientCredentials: false,
        enterpriseManagedAuth: false,
      },
    });
    await fixture.catalog.addMcpServer('default', 'docs', server('https://one.example.com/mcp'));
    await fixture.catalog.setMcpServerEnabled('default', 'docs', true);

    await fixture.catalog.addMcpServer('default', 'docs', server('https://two.example.com/mcp'), {
      replace: true,
    });

    const bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.enabled).toEqual(['docs']);
    expect(bundle.profile.mcp?.enabled).toEqual(['docs']);
  });

  it('preserves labels when replacing servers and supports relabeling and clearing', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const server = (url: string, label?: string) => ({
      ...(label === undefined ? {} : { label }),
      transport: 'streamable-http' as const,
      url,
      auth: { mode: 'none' as const },
      extensions: {
        tasks: false,
        skills: false,
        apps: false,
        oauthClientCredentials: false,
        enterpriseManagedAuth: false,
      },
    });
    await fixture.catalog.addMcpServer(
      'default',
      'docs',
      server('https://one.example.com/mcp', 'Documentation'),
    );

    await fixture.catalog.addMcpServer('default', 'docs', server('https://two.example.com/mcp'), {
      replace: true,
    });
    expect((await fixture.catalog.getBundle('default')).mcp.servers.docs?.label).toBe(
      'Documentation',
    );

    await fixture.catalog.setMcpServerLabel('default', 'docs', '  Work Docs  ');
    expect((await fixture.catalog.getBundle('default')).mcp.servers.docs?.label).toBe('Work Docs');

    await fixture.catalog.setMcpServerLabel('default', 'docs', undefined);
    expect((await fixture.catalog.getBundle('default')).mcp.servers.docs).not.toHaveProperty(
      'label',
    );
    await expect(
      fixture.catalog.setMcpServerLabel('default', 'ghost', 'Missing'),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('updates labels in profiles containing legacy and modern HTTP servers', async () => {
    const fixture = await catalog();
    await fixture.catalog.ensureDefaultIfEmpty();
    const mcpPath = path.join(fixture.root, 'profiles', 'default', 'mcp.yaml');
    await writeFile(
      mcpPath,
      [
        'schemaVersion: 2',
        'servers:',
        '  legacy:',
        '    transport: streamable-http',
        '    url: https://legacy.example.com/mcp',
        '    authPlugin: legacy-auth',
        '  modern:',
        '    transport: streamable-http',
        '    url: https://modern.example.com/mcp',
        '    auth:',
        '      mode: none',
        'enabled: []',
        'roots: []',
        '',
      ].join('\n'),
      'utf8',
    );

    await fixture.catalog.setMcpServerLabel('default', 'modern', 'Modern docs');
    await fixture.catalog.setMcpServerLabel('default', 'legacy', 'Legacy docs');
    let bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.servers.modern?.label).toBe('Modern docs');
    expect(bundle.mcp.servers.legacy).toMatchObject({
      label: 'Legacy docs',
      authPlugin: 'legacy-auth',
      auth: { mode: 'bearer', credential: { source: 'plugin', id: 'legacy-auth' } },
    });

    await fixture.catalog.setMcpServerLabel('default', 'legacy', undefined);
    bundle = await fixture.catalog.getBundle('default');
    expect(bundle.mcp.servers.legacy).not.toHaveProperty('label');
    expect(bundle.mcp.servers.modern?.label).toBe('Modern docs');
  });

  it('validates all model, provider, MCP, instruction, and tool-rule references', async () => {
    const fixture = await catalog();
    const invalid = profile({
      model: {
        primary: 'missing/no-model',
        fallback: ['openai/no-model'],
        parameters: {},
      },
      mcp: { enabled: ['ghost'] },
      tools: {
        defaultPolicy: 'deny',
        rules: [
          { tool: 'files.read', action: 'allow' },
          { tool: 'ghost.write', action: 'ask' },
        ],
      },
      agent: { instructionsFile: '../../missing.md', maxSteps: 5 },
    });
    const result = await fixture.catalog.validate(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'provider-not-found',
        'model-not-found',
        'mcp-not-found',
        'tool-server-disabled',
        'instructions-invalid',
      ]),
    );
  });

  it('validates before create/update and protects the active profile until deactivated', async () => {
    const fixture = await catalog();
    await fixture.catalog.create(profile());
    const snapshot = await fixture.catalog.resolve('coding', { workspace: '/workspace' });
    fixture.active.active = snapshot;

    await expect(fixture.catalog.delete('coding')).rejects.toMatchObject({
      code: 'PROFILE_ACTIVE',
    });
    fixture.active.active = undefined;
    await fixture.catalog.delete('coding');
    expect(await fixture.catalog.list()).toEqual([]);

    await expect(
      fixture.catalog.create(
        profile({
          id: asProfileId('bad'),
          model: { primary: 'openai/missing', fallback: [], parameters: {} },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });

  it('rejects instruction traversal and files larger than 1 MiB', async () => {
    const fixture = await catalog();
    const outside = path.join(fixture.root, 'outside.md');
    await writeFile(outside, 'outside', 'utf8');
    const traversal = await fixture.catalog.validate(
      profile({ agent: { instructionsFile: '../outside.md', maxSteps: 5 } }),
    );
    expect(traversal.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'instructions-invalid' })]),
    );

    const large = path.join(fixture.root, 'instructions', 'large.md');
    await writeFile(large, 'x'.repeat(1_048_577), 'utf8');
    const oversized = await fixture.catalog.validate(
      profile({ agent: { instructionsFile: '../instructions/large.md', maxSteps: 5 } }),
    );
    expect(oversized.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'instructions-invalid' })]),
    );
  });
});
