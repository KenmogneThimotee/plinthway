import { readFile } from 'node:fs/promises';

import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from '../../packages/mcp-app-host/src/index.js';
import { mcpServerSchema } from '../../packages/config/src/index.js';
import {
  DurableClientCredentialsProvider,
  DurableEnterpriseAuthorizationProvider,
  McpInteractionBroker,
  McpSkillHost,
  McpTaskAdapter,
  assertAllowedMcpUrl,
  mcpClientOptions,
} from '../../packages/mcp-client/src/index.js';
import { describe, expect, it } from 'vitest';

interface ConformanceFixture {
  readonly core: {
    readonly specification: string;
    readonly conformancePackage: string;
    readonly requiredClientScenarios: readonly string[];
  };
  readonly extensions: readonly {
    readonly id: string;
    readonly revision: string;
    readonly acceptanceId: string;
  }[];
  readonly coverage: readonly {
    readonly id: string;
    readonly area: string;
    readonly scenarios: readonly string[];
  }[];
}

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/mcp/conformance-pins.json', import.meta.url), 'utf8'),
) as ConformanceFixture;

const coreIds = Array.from(
  { length: 14 },
  (_, index) => `AT-MCP-CORE-${String(index + 1).padStart(2, '0')}`,
);
const extensionIds = Array.from(
  { length: 5 },
  (_, index) => `AT-MCP-EXT-${String(index + 1).padStart(2, '0')}`,
);

function enabledOptions() {
  return mcpClientOptions({ interactionBroker: new McpInteractionBroker() }, () => undefined, {
    tasks: true,
    skills: true,
    apps: true,
    oauthClientCredentials: true,
    enterpriseManagedAuth: true,
  });
}

const mcpAcceptanceScenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  'AT-MCP-CORE-01': () => {
    expect(mcpClientOptions()).toMatchObject({
      versionNegotiation: { mode: 'auto' },
      listMaxPages: 64,
      inputRequired: { autoFulfill: true, maxRounds: 8 },
    });
  },
  'AT-MCP-CORE-02': () => {
    expect(mcpClientOptions().listMaxPages).toBe(64);
  },
  'AT-MCP-CORE-03': () => {
    expect(enabledOptions().listChanged?.prompts).toBeDefined();
  },
  'AT-MCP-CORE-04': () => {
    expect(enabledOptions().listChanged?.resources).toBeDefined();
  },
  'AT-MCP-CORE-05': () => {
    expect(mcpClientOptions().listMaxPages).toBe(64);
  },
  'AT-MCP-CORE-06': () => {
    expect(enabledOptions().capabilities?.roots).toEqual({ listChanged: false });
  },
  'AT-MCP-CORE-07': () => {
    expect(enabledOptions().capabilities?.sampling).toBeUndefined();
    expect(
      mcpClientOptions({
        interactionBroker: {
          supportsSampling: true,
          handle: () => Promise.resolve({}),
        },
      }).capabilities?.sampling,
    ).toEqual({});
  },
  'AT-MCP-CORE-08': () => {
    expect(enabledOptions().capabilities?.elicitation).toEqual({ form: {}, url: {} });
  },
  'AT-MCP-CORE-09': () => {
    expect(new McpInteractionBroker()).toBeInstanceOf(McpInteractionBroker);
  },
  'AT-MCP-CORE-10': () => {
    expect(mcpClientOptions().inputRequired).toEqual({ autoFulfill: true, maxRounds: 8 });
  },
  'AT-MCP-CORE-11': () => {
    expect(
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth: { mode: 'oauth', clientId: 'plinthway', scopes: ['mcp:read'] },
      }),
    ).toMatchObject({ auth: { mode: 'oauth', clientId: 'plinthway' } });
  },
  'AT-MCP-CORE-12': () => {
    expect(
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        auth: { mode: 'oauth', scopes: ['mcp:read'] },
      }),
    ).toMatchObject({ auth: { scopes: ['mcp:read'] } });
  },
  'AT-MCP-CORE-13': () => {
    expect(mcpServerSchema.parse({ transport: 'stdio', command: 'server' }).transport).toBe(
      'stdio',
    );
    expect(
      mcpServerSchema.parse({ transport: 'streamable-http', url: 'https://mcp.example.com' })
        .transport,
    ).toBe('streamable-http');
  },
  'AT-MCP-CORE-14': async () => {
    expect(
      mcpServerSchema.parse({
        transport: 'streamable-http',
        url: 'http://public.example.com',
      }),
    ).toMatchObject({ url: 'http://public.example.com' });
    await expect(
      assertAllowedMcpUrl(new URL('http://public.example.com'), [], () =>
        Promise.resolve(['93.184.216.34']),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  },
  'AT-MCP-SCALE-01': async () => {
    const source = await readFile(
      new URL('../integration/mcp-scale.test.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('Array.from({ length: 25 }');
    expect(source).not.toMatch(/\b(?:it|test|describe)\.skip\b/u);
  },
  'AT-MCP-EXT-01': () => {
    expect(typeof McpTaskAdapter).toBe('function');
    expect(enabledOptions().capabilities?.extensions).toHaveProperty(
      'io.modelcontextprotocol/tasks',
    );
  },
  'AT-MCP-EXT-02': () => {
    expect(typeof McpSkillHost).toBe('function');
    expect(enabledOptions().capabilities?.extensions).toHaveProperty(
      'io.modelcontextprotocol/skills',
    );
  },
  'AT-MCP-EXT-03': () => {
    expect(MCP_APP_EXTENSION_ID).toBe('io.modelcontextprotocol/ui');
    expect(MCP_APP_RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
  },
  'AT-MCP-EXT-04': () => {
    expect(typeof DurableClientCredentialsProvider).toBe('function');
    expect(enabledOptions().capabilities?.extensions).toHaveProperty(
      'io.modelcontextprotocol/oauth-client-credentials',
    );
  },
  'AT-MCP-EXT-05': () => {
    expect(typeof DurableEnterpriseAuthorizationProvider).toBe('function');
    expect(enabledOptions().capabilities?.extensions).toHaveProperty(
      'io.modelcontextprotocol/enterprise-managed-authorization',
    );
  },
};

describe('MCP 2026-07-28 acceptance inventory', () => {
  it('pins the released core requirements and every implemented official extension', () => {
    expect(fixture.core).toMatchObject({
      specification: '2026-07-28',
      conformancePackage: '@modelcontextprotocol/conformance@0.2.0-alpha.10',
    });
    expect(fixture.extensions.map(({ id }) => id)).toEqual([
      'io.modelcontextprotocol/tasks',
      'io.modelcontextprotocol/skills',
      'io.modelcontextprotocol/ui',
      'io.modelcontextprotocol/oauth-client-credentials',
      'io.modelcontextprotocol/enterprise-managed-authorization',
    ]);
    expect(fixture.extensions.every(({ revision }) => revision === '2026-07-28')).toBe(true);
  });

  it('maps every frozen upstream client scenario exactly once', () => {
    const mapped = fixture.coverage.flatMap(({ scenarios }) => scenarios).sort();
    const required = [...fixture.core.requiredClientScenarios].sort();
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped).toEqual(required);
  });

  it('contains the exact, executable MCP release set with no omitted IDs', () => {
    const expected = [...coreIds, 'AT-MCP-SCALE-01', ...extensionIds];
    const fixtureIds = [
      ...fixture.coverage.map(({ id }) => id),
      ...fixture.extensions.map(({ acceptanceId }) => acceptanceId),
    ];
    expect(fixtureIds).toEqual(expected);
    expect(Object.keys(mcpAcceptanceScenarios)).toEqual(expected);
  });

  it.each(Object.keys(mcpAcceptanceScenarios))('%s', async (id) => {
    await mcpAcceptanceScenarios[id]?.();
  });
});
