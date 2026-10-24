#!/usr/bin/env node

import {
  connectMcpServer,
  PlinthwayOAuthClientProvider,
  McpOAuthController,
} from '../../packages/mcp-client/src/index.js';

const serverUrl = process.argv[2];
if (serverUrl === undefined) throw new Error('Conformance server URL is required');

const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const context = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}') as Record<string, unknown>;

class MemoryCredentialStore {
  readonly source = 'keyring' as const;
  readonly values = new Map<string, unknown>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

function challengeParameter(challenge: string, name: string): string | undefined {
  const quoted = challenge.match(new RegExp(`(?:^|[,\\s])${name}="([^"]*)"`, 'iu'))?.[1];
  if (quoted !== undefined) return quoted;
  return challenge.match(new RegExp(`(?:^|[,\\s])${name}=([^,\\s]+)`, 'iu'))?.[1];
}

const rawFetch = globalThis.fetch;
let fetchImplementation: typeof globalThis.fetch = rawFetch;
if (scenario.startsWith('auth/')) {
  const controller = new McpOAuthController();
  let callback:
    { readonly code: string; readonly state: string; readonly issuer?: string } | undefined;
  const provider = new PlinthwayOAuthClientProvider({
    serverId: 'conformance',
    serverUrl,
    redirectUrl: 'http://localhost:3000/callback',
    ...(typeof context.client_id === 'string' ? { clientId: context.client_id } : {}),
    ...(typeof context.client_secret === 'string' ? { clientSecret: context.client_secret } : {}),
    ...(typeof context.client_id === 'string' || scenario !== 'auth/basic-cimd'
      ? {}
      : { clientMetadataUrl: 'https://conformance-test.local/client-metadata.json' }),
    scopes: [],
    store: new MemoryCredentialStore() as never,
    redirectToAuthorization: async (authorizationUrl) => {
      const response = await rawFetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (location === null) throw new Error('Authorization response omitted Location');
      const redirected = new URL(location);
      const code = redirected.searchParams.get('code');
      const state = redirected.searchParams.get('state');
      if (code === null || state === null) throw new Error('Authorization callback is incomplete');
      const issuer = redirected.searchParams.get('iss');
      callback = { code, state, ...(issuer === null ? {} : { issuer }) };
    },
  });
  controller.register('conformance', serverUrl, provider, [], rawFetch);

  fetchImplementation = async (input, init) => {
    const baseRequest = new Request(input, init);
    const makeRequest = async (): Promise<Response> => {
      const request = baseRequest.clone();
      const tokens = await provider.tokens();
      if (tokens !== undefined)
        request.headers.set('authorization', `Bearer ${tokens.access_token}`);
      return rawFetch(request, init);
    };
    let response = await makeRequest();
    if (response.status !== 401 && response.status !== 403) return response;
    const challenge = response.headers.get('www-authenticate') ?? '';
    const resourceMetadataUrl = challengeParameter(challenge, 'resource_metadata');
    const requiredScope = challengeParameter(challenge, 'scope');
    const started = await controller.authorize('conformance', {
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
      ...(requiredScope === undefined ? {} : { requiredScope }),
    });
    if (started.state === 'redirect') {
      if (callback === undefined) throw new Error('OAuth callback was not captured');
      const captured = callback;
      callback = undefined;
      await controller.authorize('conformance', {
        code: captured.code,
        state: captured.state,
        ...(captured.issuer === undefined ? {} : { issuer: captured.issuer }),
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        ...(requiredScope === undefined ? {} : { requiredScope }),
      });
    }
    response = await makeRequest();
    return response;
  };
}

const interactionBroker = {
  supportsSampling: true,
  handle: (_serverId: string, method: string): Promise<never> => {
    if (method === 'roots/list') return Promise.resolve({ roots: [] } as never);
    if (method === 'sampling/createMessage') {
      return Promise.resolve({
        role: 'assistant',
        content: { type: 'text', text: 'sampled' },
        model: 'conformance',
        stopReason: 'endTurn',
      } as never);
    }
    return Promise.resolve({ action: 'accept', content: { confirmed: true } } as never);
  },
};

const connection = await connectMcpServer(
  {
    id: 'conformance',
    transport: 'streamable-http',
    url: serverUrl,
    auth: { mode: 'none' },
  },
  {
    allowedHttpOrigins: [new URL(serverUrl).origin],
    connectTimeoutMs: 15_000,
    protocolProbeTimeoutMs: 10_000,
    fetch: fetchImplementation,
    interactionBroker,
  },
);

try {
  const tools = await connection.listTools();
  if (scenario === 'tools_call' || scenario === 'tools-call') {
    const tool = tools[0];
    if (tool === undefined) throw new Error('Conformance server advertised no tools');
    await connection.callTool(tool.name, { a: 2, b: 3 }, { timeoutMs: 10_000 });
  } else if (scenario === 'json-schema-2020-12-preservation') {
    const focal = tools.find((tool) => tool.name === 'json_schema_2020_12_tool');
    if (focal === undefined) throw new Error('JSON Schema conformance tool is missing');
    await connection.callTool('json_schema_echo', { schema: focal.inputSchema } as never, {
      timeoutMs: 10_000,
    });
  } else if (scenario === 'sep-2322-client-request-state') {
    for (const tool of tools.filter((entry) => entry.name.startsWith('test_mrtr_'))) {
      await connection.callTool(tool.name, {}, { timeoutMs: 10_000 });
    }
  } else if (scenario === 'http-custom-headers' && Array.isArray(context.toolCalls)) {
    for (const call of context.toolCalls as Array<{
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }>) {
      await connection.callTool(call.name, call.arguments as never, { timeoutMs: 10_000 });
    }
  } else if (scenario === 'http-invalid-tool-headers') {
    for (const tool of tools) await connection.callTool(tool.name, {}, { timeoutMs: 10_000 });
  } else if (scenario.startsWith('auth/')) {
    await connection.callTool('test-tool', {}, { timeoutMs: 10_000 });
  }
} finally {
  await connection.close();
}
