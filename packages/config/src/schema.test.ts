import { describe, expect, it } from 'vitest';

import { globalConfigSchema, mcpServerSchema } from './schema.js';

describe('globalConfigSchema', () => {
  const minimal = {
    schemaVersion: 1,
    providers: {},
    mcpServers: {},
    security: {},
  };

  it('applies secure defaults and rejects unknown keys', () => {
    const parsed = globalConfigSchema.parse(minimal);
    expect(parsed.security.defaultToolPolicy).toBe('deny');
    expect(parsed.registry.source).toBe('https://models.dev/api.json');
    expect(() => globalConfigSchema.parse({ ...minimal, surprise: true })).toThrow();
  });

  it('defers HTTP MCP destination trust to runtime without weakening other secure URLs', () => {
    const withServer = (url: string) => ({
      ...minimal,
      mcpServers: { docs: { transport: 'streamable-http', url } },
    });
    expect(globalConfigSchema.parse(withServer('http://localhost:3333/mcp'))).toBeDefined();
    expect(globalConfigSchema.parse(withServer('http://api.local.test/mcp'))).toBeDefined();
    expect(globalConfigSchema.parse(withServer('http://example.com/mcp'))).toBeDefined();
    expect(globalConfigSchema.parse(withServer('https://example.com/mcp'))).toBeDefined();
    expect(() => globalConfigSchema.parse(withServer('ftp://example.com/mcp'))).toThrow();
    expect(() =>
      globalConfigSchema.parse({
        ...minimal,
        registry: { source: 'http://api.local.test/models.json' },
      }),
    ).toThrow();
  });

  it('returns validation issues instead of throwing for malformed MCP endpoint URLs', () => {
    expect(() =>
      mcpServerSchema.safeParse({ transport: 'streamable-http', url: 'not-a-url' }),
    ).not.toThrow();
    expect(
      mcpServerSchema.safeParse({ transport: 'streamable-http', url: 'not-a-url' }).success,
    ).toBe(false);
  });

  it.each(['filesystem', 'shell'])('reserves the %s MCP server namespace', (serverId) => {
    expect(() =>
      globalConfigSchema.parse({
        ...minimal,
        mcpServers: {
          [serverId]: { transport: 'streamable-http', url: 'https://mcp.example.com' },
        },
      }),
    ).toThrow(/reserved/u);
  });

  it('allows only environment names in stdio server definitions', () => {
    const parsed = globalConfigSchema.parse({
      ...minimal,
      mcpServers: {
        files: {
          transport: 'stdio',
          command: 'server',
          args: ['${WORKSPACE}'],
          env: ['PATH', 'PUBLIC_SETTING'],
        },
      },
    });
    expect(parsed.mcpServers.files).toMatchObject({ env: ['PATH', 'PUBLIC_SETTING'] });
    expect(() =>
      globalConfigSchema.parse({
        ...minimal,
        mcpServers: {
          files: { transport: 'stdio', command: 'server', args: [], env: ['TOKEN=value'] },
        },
      }),
    ).toThrow();
  });

  it('normalizes every HTTP authorization mode without accepting secret material', () => {
    const modes = [
      { mode: 'none' },
      { mode: 'bearer', credential: { source: 'keyring', id: 'docs-token' } },
      { mode: 'oauth', clientId: 'plinthway-cli', scopes: ['mcp:read'] },
      {
        mode: 'client-credentials',
        clientId: 'plinthway-service',
        issuer: 'https://auth.example.com',
        authentication: 'client-secret-basic',
        credential: { source: 'keyring', id: 'service-secret' },
        scopes: ['mcp:read'],
      },
      { mode: 'enterprise', managedProfile: 'workforce' },
    ] as const;

    for (const auth of modes) {
      const parsed = mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth,
        extensions:
          auth.mode === 'client-credentials'
            ? { oauthClientCredentials: true }
            : auth.mode === 'enterprise'
              ? { enterpriseManagedAuth: true }
              : {},
      });
      expect(parsed).toMatchObject({ auth: { mode: auth.mode } });
    }

    expect(() =>
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth: { mode: 'bearer', token: 'plaintext-secret' },
      }),
    ).toThrow();
    expect(() =>
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth: {
          mode: 'client-credentials',
          clientId: 'plinthway-service',
          issuer: 'https://auth.example.com',
          authentication: 'client-secret-basic',
          credential: { source: 'keyring', id: 'service-secret' },
        },
      }),
    ).toThrow(/explicitly enabled/u);
    expect(() =>
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth: {
          mode: 'client-credentials',
          clientId: 'plinthway-service',
          issuer: 'https://auth.example.com',
          authentication: 'client-secret-basic',
          clientSecret: 'plaintext-secret',
        },
      }),
    ).toThrow();
  });

  it('keeps all official extensions disabled unless explicitly enabled', () => {
    const parsed = mcpServerSchema.parse({
      transport: 'stdio',
      command: 'server',
    });
    expect(parsed.extensions).toEqual({
      tasks: false,
      skills: false,
      apps: false,
      oauthClientCredentials: false,
      enterpriseManagedAuth: false,
    });

    const enabled = mcpServerSchema.parse({
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      extensions: { tasks: true },
    });
    expect(enabled.extensions).toMatchObject({ tasks: true, apps: false });
    expect(() =>
      mcpServerSchema.parse({
        transport: 'stdio',
        command: 'server',
        extensions: { futureExtension: true },
      }),
    ).toThrow();
  });

  it('normalizes optional MCP labels and rejects labels that cannot be rendered on one line', () => {
    const remote = mcpServerSchema.parse({
      label: '  Équipe Notion  ',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
    });
    const stdio = mcpServerSchema.parse({
      label: 'Local files',
      transport: 'stdio',
      command: 'files-server',
    });
    const legacy = mcpServerSchema.parse({
      label: 'Legacy docs',
      transport: 'streamable-http',
      url: 'https://legacy.example.com',
      authPlugin: 'legacy-auth',
    });

    expect(remote.label).toBe('Équipe Notion');
    expect(stdio.label).toBe('Local files');
    expect(legacy.label).toBe('Legacy docs');
    expect(() =>
      mcpServerSchema.parse({
        label: '   ',
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
      }),
    ).toThrow();
    expect(() =>
      mcpServerSchema.parse({
        label: 'Docs\nProduction',
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
      }),
    ).toThrow();
    for (const label of [
      'Docs\u2028Production',
      'Docs\u2029Production',
      'Docs\tProduction',
      'Docs\u001b[2J',
    ]) {
      expect(() =>
        mcpServerSchema.parse({
          label,
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
        }),
      ).toThrow();
    }
    expect(() =>
      mcpServerSchema.parse({
        label: 'x'.repeat(81),
        transport: 'stdio',
        command: 'files-server',
      }),
    ).toThrow();
  });

  it('round-trips parsed legacy MCP servers through the schema', () => {
    const parsed = mcpServerSchema.parse({
      label: 'Legacy docs',
      transport: 'streamable-http',
      url: 'https://legacy.example.com',
      authPlugin: 'legacy-auth',
    });

    expect(() => mcpServerSchema.parse(parsed)).not.toThrow();
    expect(mcpServerSchema.parse(parsed)).toEqual(parsed);
  });
});
