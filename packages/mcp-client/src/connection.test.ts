import { describe, expect, it, vi } from 'vitest';
import {
  Client,
  InMemoryTransport,
  SdkError,
  SdkErrorCode,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

import {
  McpConnection,
  mapConnectionError,
  mcpClientOptions,
  minimalEnvironment,
  validateStdioConfig,
} from './connection.js';
import { BoundedResponseCacheStore } from './response-cache.js';
import type { McpTaskEvent } from './contracts.js';
import type { McpInteractionBrokerPort } from './interaction-broker.js';
import { TaskMultiplexTransport } from './task-transport.js';

interface JsonRpcRequestFixture {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequestFixture {
  return (
    message !== null &&
    typeof message === 'object' &&
    'id' in message &&
    (typeof message.id === 'string' || typeof message.id === 'number') &&
    'method' in message &&
    typeof message.method === 'string'
  );
}

describe('stdio isolation', () => {
  it('passes only platform essentials and explicitly allowlisted variables', () => {
    const env = minimalEnvironment(['EXPLICIT'], {
      PATH: '/bin',
      HOME: '/home/test',
      EXPLICIT: 'visible',
      SECRET_TOKEN: 'hidden',
    });

    expect(env.EXPLICIT).toBe('visible');
    expect(env.PATH).toBe('/bin');
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain('hidden');
  });

  it('rejects NULs in process configuration', () => {
    expect(() => {
      validateStdioConfig({
        id: 'bad',
        transport: 'stdio',
        command: 'node\0sh',
        args: [],
        env: [],
      });
    }).toThrow();
  });
});

describe('protocol negotiation', () => {
  function connection(era: 'modern' | 'legacy') {
    const client = {
      onclose: undefined,
      onerror: undefined,
      getProtocolEra: () => era,
      getNegotiatedProtocolVersion: () => (era === 'modern' ? '2026-07-28' : '2025-11-25'),
      getServerVersion: () => ({
        name: 'fixture',
        title: 'Fixture server',
        version: '1.2.3',
      }),
      getServerCapabilities: () => ({ tools: { listChanged: true }, resources: {} }),
      getDiscoverResult: () => undefined,
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      setNotificationHandler: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const transport = { terminateSession: vi.fn().mockResolvedValue(undefined) };
    const value = new McpConnection('fixture', client as never, transport as never);
    value.markReady();
    return { value, client, transport };
  }

  it('opts into 2026 negotiation with bounded pagination and MRTR', () => {
    expect(mcpClientOptions()).toMatchObject({
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000, maxRetries: 0 } },
      listMaxPages: 64,
      inputRequired: { autoFulfill: true, maxRounds: 8 },
    });
    const responseCacheStore = new BoundedResponseCacheStore();
    expect(mcpClientOptions({ responseCacheStore, cachePartition: 'docs:user-1' })).toMatchObject({
      responseCacheStore,
      cachePartition: 'docs:user-1',
    });
  });

  it('advertises authorization extensions only when explicitly enabled', () => {
    expect(mcpClientOptions().capabilities?.extensions).toBeUndefined();
    expect(
      mcpClientOptions({}, undefined, {
        oauthClientCredentials: true,
        enterpriseManagedAuth: true,
      }).capabilities?.extensions,
    ).toEqual({
      'io.modelcontextprotocol/oauth-client-credentials': {},
      'io.modelcontextprotocol/enterprise-managed-authorization': {},
    });
  });

  it('negotiates 2026 through server/discover and sends per-request metadata', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let discoverMeta: unknown;
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message) || message.method !== 'server/discover') return;
      const params = message.params as { readonly _meta?: unknown } | undefined;
      discoverMeta = params?._meta;
      void serverTransport.send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: 'private',
        },
      });
    };
    await serverTransport.start();
    const client = new Client({ name: 'plinthway-test', version: '1.0.0' }, mcpClientOptions());
    await client.connect(clientTransport, { timeout: 1_000 });
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(discoverMeta).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    });
    await client.close();
    await serverTransport.close();
  });

  it('aggregates paginated lists and preserves an opaque empty cursor', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const seenCursors: unknown[] = [];
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        });
      }
      if (message.method === 'tools/list') {
        const params = message.params as { readonly cursor?: unknown } | undefined;
        seenCursors.push(params?.cursor);
        const secondPage = params !== undefined && 'cursor' in params;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: [
              {
                name: secondPage ? 'second' : 'first',
                inputSchema: { type: 'object' },
              },
            ],
            ...(secondPage ? {} : { nextCursor: '' }),
          },
        });
      }
    };
    await serverTransport.start();
    const client = new Client({ name: 'plinthway-test', version: '1.0.0' }, mcpClientOptions());
    await client.connect(clientTransport, { timeout: 1_000 });
    const mcp = new McpConnection('fixture', client);
    mcp.markReady();

    await expect(mcp.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'first' }),
      expect.objectContaining({ name: 'second' }),
    ]);
    expect(seenCursors).toEqual([undefined, '']);
    await mcp.close();
    await serverTransport.close();
  });

  it('excludes tools whose x-mcp-header is attached to a number schema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        });
      }
      if (message.method === 'tools/list') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: [
              { name: 'valid', inputSchema: { type: 'object' } },
              {
                name: 'invalid-number',
                inputSchema: {
                  type: 'object',
                  properties: {
                    ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
                  },
                },
              },
            ],
          },
        });
      }
    };
    await serverTransport.start();
    const client = new Client({ name: 'plinthway-test', version: '1.0.0' }, mcpClientOptions());
    await client.connect(clientTransport, { timeout: 1_000 });
    const mcp = new McpConnection('fixture', client);
    mcp.markReady();

    await expect(mcp.listTools()).resolves.toEqual([expect.objectContaining({ name: 'valid' })]);
    await mcp.close();
    await serverTransport.close();
  });

  it('negotiates and calls the Skills extension with modern request metadata', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let skillsMeta: unknown;
    const content = '---\nname: review\ndescription: Review changes\n---\n';
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: {
              resources: {},
              extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } },
            },
          },
        });
      }
      if (message.method === 'skills/list') {
        skillsMeta = (message.params as { readonly _meta?: unknown } | undefined)?._meta;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            skills: [
              {
                uri: 'skill://docs/review/SKILL.md',
                frontmatter: { name: 'review', description: 'Review changes' },
                resources: 'dynamic',
              },
            ],
            ttlMs: 30_000,
            cacheScope: 'private',
          },
        });
      }
      if (message.method === 'resources/read') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            contents: [
              { uri: 'skill://docs/review/SKILL.md', mimeType: 'text/markdown', text: content },
            ],
            ttlMs: 0,
            cacheScope: 'private',
          },
        });
      }
    };
    await serverTransport.start();
    const client = new Client(
      { name: 'plinthway-test', version: '1.0.0' },
      mcpClientOptions({}, undefined, { skills: true }),
    );
    await client.connect(clientTransport, { timeout: 1_000 });
    const mcp = new McpConnection('docs', client);
    mcp.markReady();
    mcp.enableSkills(true);

    await expect(mcp.listSkills()).resolves.toEqual([
      expect.objectContaining({ serverId: 'docs', uri: 'skill://docs/review/SKILL.md' }),
    ]);
    expect(skillsMeta).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/skills': {} },
      },
    });
    await expect(mcp.readSkillResource('skill://docs/review/SKILL.md')).resolves.toMatchObject({
      bytes: Buffer.from(content),
    });
    await mcp.close();
    await serverTransport.close();
  });

  it('rejects list pagination that does not converge within 64 pages', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let pages = 0;
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        });
      }
      if (message.method === 'tools/list') {
        pages += 1;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: [{ name: `tool-${String(pages)}`, inputSchema: { type: 'object' } }],
            nextCursor: String(pages),
          },
        });
      }
    };
    await serverTransport.start();
    const client = new Client({ name: 'plinthway-test', version: '1.0.0' }, mcpClientOptions());
    await client.connect(clientTransport, { timeout: 1_000 });
    const mcp = new McpConnection('fixture', client);
    mcp.markReady();

    await expect(mcp.listTools()).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    expect(pages).toBe(64);
    await mcp.close();
    await serverTransport.close();
  });

  it('opens a modern list subscription and invalidates cached lists on notification', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let listRequests = 0;
    let listenId: string | undefined;
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: { listChanged: true } },
          },
        });
      }
      if (message.method === 'subscriptions/listen') {
        listenId = String(message.id);
        void serverTransport.send({
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: {
            _meta: { 'io.modelcontextprotocol/subscriptionId': listenId },
            notifications: { toolsListChanged: true },
          },
        });
      }
      if (message.method === 'tools/list') {
        listRequests += 1;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 60_000,
            cacheScope: 'private',
            tools: [{ name: `version-${String(listRequests)}`, inputSchema: { type: 'object' } }],
          },
        });
      }
    };
    await serverTransport.start();
    const changes: string[] = [];
    const client = new Client(
      { name: 'plinthway-test', version: '1.0.0' },
      mcpClientOptions({}, (catalog) => {
        changes.push(catalog);
      }),
    );
    await client.connect(clientTransport, { timeout: 1_000 });
    const connection = new McpConnection('fixture', client);
    connection.markReady();

    await expect(connection.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'version-1' }),
    ]);
    await connection.listTools();
    expect(listRequests).toBe(1);
    await serverTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {
        _meta: { 'io.modelcontextprotocol/subscriptionId': listenId },
      },
    });
    await vi.waitFor(() => {
      expect(changes).toEqual(['tools']);
    });
    await expect(connection.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'version-2' }),
    ]);
    expect(listRequests).toBe(2);
    await connection.close();
    await serverTransport.close();
  });

  it('opts into V2 Tasks per request and settles a polymorphic task result', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let taskCapability: unknown;
    let listenedTaskIds: unknown;
    let taskInputResponses: unknown;
    let polls = 0;
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
          },
        });
      } else if (message.method === 'tools/list') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            tools: [
              {
                name: 'report',
                inputSchema: { type: 'object' },
                execution: { taskSupport: 'optional' },
              },
            ],
          },
        });
      } else if (message.method === 'tools/call') {
        const params = message.params as {
          readonly _meta?: {
            readonly 'io.modelcontextprotocol/clientCapabilities'?: {
              readonly extensions?: Readonly<Record<string, unknown>>;
            };
          };
        };
        taskCapability =
          params._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[
            'io.modelcontextprotocol/tasks'
          ];
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'task',
            taskId: 'task-1',
            status: 'working',
            createdAt: '2026-10-18T00:00:00.000Z',
            lastUpdatedAt: '2026-10-18T00:00:00.000Z',
            ttlMs: 60_000,
            pollIntervalMs: 1,
          },
        });
      } else if (message.method === 'subscriptions/listen') {
        const params = message.params as {
          readonly notifications?: { readonly taskIds?: unknown };
        };
        listenedTaskIds = params.notifications?.taskIds;
        void serverTransport.send({
          jsonrpc: '2.0',
          method: 'notifications/tasks',
          params: {
            taskId: 'task-1',
            status: 'working',
            createdAt: '2026-10-18T00:00:00.000Z',
            lastUpdatedAt: '2026-10-18T00:00:00.500Z',
            ttlMs: 60_000,
            pollIntervalMs: 1,
          },
        });
      } else if (message.method === 'tasks/get') {
        polls += 1;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result:
            taskInputResponses === undefined
              ? {
                  resultType: 'complete',
                  taskId: 'task-1',
                  status: 'input_required',
                  createdAt: '2026-10-18T00:00:00.000Z',
                  lastUpdatedAt: '2026-10-18T00:00:01.000Z',
                  ttlMs: 60_000,
                  pollIntervalMs: 1,
                  inputRequests: {
                    name: {
                      method: 'elicitation/create',
                      params: {
                        message: 'Your name?',
                        requestedSchema: {
                          type: 'object',
                          properties: { input: { type: 'string' } },
                        },
                      },
                    },
                  },
                }
              : {
                  resultType: 'complete',
                  taskId: 'task-1',
                  status: 'completed',
                  createdAt: '2026-10-18T00:00:00.000Z',
                  lastUpdatedAt: '2026-10-18T00:00:02.000Z',
                  ttlMs: 60_000,
                  pollIntervalMs: 1,
                  result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
                },
        });
      } else if (message.method === 'tasks/update') {
        taskInputResponses = (message.params as { readonly inputResponses?: unknown })
          .inputResponses;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { resultType: 'complete' },
        });
      }
    };
    await serverTransport.start();
    const handle = vi.fn(() => Promise.resolve({ action: 'accept', content: { input: 'Ada' } }));
    const broker: McpInteractionBrokerPort = { handle };
    const options = mcpClientOptions({ interactionBroker: broker });
    const client = new Client({ name: 'plinthway-test', version: '1.0.0' }, options);
    const transport = new TaskMultiplexTransport(clientTransport);
    const connection = new McpConnection(
      'docs',
      client,
      undefined,
      broker,
      transport,
      options.capabilities as never,
      'e1',
    );
    await client.connect(transport, { timeout: 1_000 });
    connection.markReady();
    connection.enableTasks(true);
    await connection.listTools();

    const started = await connection.callToolTask('report', {}, { timeoutMs: 1_000 });
    expect(started.kind).toBe('task');
    expect(started.reference).toMatchObject({ taskId: 'task-1', generation: 'v2' });
    const taskEvents: McpTaskEvent[] = [];
    const outcome = await started.settle({
      onEvent: (event) => {
        taskEvents.push(event);
      },
    });
    if (outcome.status === 'failed')
      throw new Error(`${outcome.error.message}: ${JSON.stringify(outcome.error.data)}`);
    expect(outcome).toMatchObject({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] },
    });
    expect(taskCapability).toEqual({});
    expect(listenedTaskIds).toEqual(['task-1']);
    expect(taskInputResponses).toEqual({
      name: { action: 'accept', content: { input: 'Ada' } },
    });
    expect(handle).toHaveBeenCalledWith(
      'docs',
      'elicitation/create',
      expect.objectContaining({ message: 'Your name?' }),
      expect.any(AbortSignal),
    );
    expect(polls).toBeGreaterThan(0);
    expect(
      taskEvents.some((event) => event.type === 'task' && event.task.status === 'working'),
    ).toBe(true);
    await connection.close();
    await serverTransport.close();
  });

  it.each(['modern', 'legacy'] as const)('snapshots %s discovery metadata', (era) => {
    const { value } = connection(era);
    expect(value.discovery).toMatchObject({
      protocol: { era, version: era === 'modern' ? '2026-07-28' : '2025-11-25' },
      serverInfo: { name: 'fixture', title: 'Fixture server', version: '1.2.3' },
      capabilities: { tools: { listChanged: true }, resources: {} },
    });
  });

  it('does not send the removed session-termination request on modern HTTP', async () => {
    const modern = connection('modern');
    await modern.value.close();
    expect(modern.transport.terminateSession).not.toHaveBeenCalled();
    expect(modern.client.close).toHaveBeenCalledOnce();

    const legacy = connection('legacy');
    await legacy.value.close();
    expect(legacy.transport.terminateSession).toHaveBeenCalledOnce();
  });

  it('classifies authentication and incompatible handshake failures', () => {
    const interactiveAuthorization = new UnauthorizedError(
      'Authentication requires user authorization',
    );
    expect(mapConnectionError('interactive', interactiveAuthorization)).toMatchObject({
      code: 'AUTH_FAILED',
      cause: interactiveAuthorization,
    });
    expect(
      mapConnectionError(
        'secure',
        new SdkError(SdkErrorCode.ClientHttpAuthentication, 'authorization required'),
      ),
    ).toMatchObject({ code: 'AUTH_FAILED' });
    expect(
      mapConnectionError(
        'broken',
        new SdkError(SdkErrorCode.InvalidResult, 'invalid discovery result'),
      ),
    ).toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
  });
});

describe('host events', () => {
  it('routes resource, progress, and logging notifications with server provenance', () => {
    const handlers = new Map<string, (notification: never) => void>();
    const client = {
      onclose: undefined,
      onerror: undefined,
      setNotificationHandler: vi.fn((method: string, handler: (notification: never) => void) => {
        handlers.set(method, handler);
      }),
    };
    const connection = new McpConnection('docs', client as never);
    const events: unknown[] = [];
    connection.onEvent((event) => events.push(event));

    handlers.get('notifications/resources/updated')?.({ params: { uri: 'docs://guide' } } as never);
    handlers.get('notifications/progress')?.({
      params: { progressToken: 'call-1', progress: 2, total: 4, message: 'Halfway' },
    } as never);
    handlers.get('notifications/message')?.({
      params: { level: 'warning', logger: 'fixture', data: { warning: true } },
    } as never);

    expect(events).toEqual([
      { type: 'resource-updated', serverId: 'docs', uri: 'docs://guide' },
      {
        type: 'progress',
        serverId: 'docs',
        progressToken: 'call-1',
        progress: 2,
        total: 4,
        message: 'Halfway',
      },
      {
        type: 'logging',
        serverId: 'docs',
        level: 'warning',
        logger: 'fixture',
        data: { warning: true },
      },
    ]);
  });

  it('enables SDK list subscriptions and emits catalog changes', () => {
    const changed: unknown[] = [];
    const options = mcpClientOptions({}, (catalog, error) => changed.push({ catalog, error }));
    options.listChanged?.tools?.onChanged(null, []);
    options.listChanged?.prompts?.onChanged(new Error('refresh failed'), null);

    expect(options.listChanged).toMatchObject({
      tools: { autoRefresh: false },
      prompts: { autoRefresh: false },
      resources: { autoRefresh: false },
    });
    expect(changed[0]).toEqual({ catalog: 'tools', error: null });
    expect(changed[1]).toMatchObject({
      catalog: 'prompts',
      error: expect.objectContaining({ message: 'refresh failed' }) as unknown,
    });
  });
});

describe('interactive client capabilities', () => {
  it('advertises sampling only when the broker has a sampling executor', async () => {
    const handle = vi.fn((_serverId, method) =>
      Promise.resolve(
        method === 'roots/list'
          ? { roots: [] }
          : method === 'elicitation/create'
            ? { action: 'decline' }
            : {
                role: 'assistant',
                content: { type: 'text', text: 'sampled' },
                model: 'fixture',
                stopReason: 'endTurn',
              },
      ),
    );
    const broker: McpInteractionBrokerPort = { handle, supportsSampling: true };
    expect(mcpClientOptions({ interactionBroker: broker })).toMatchObject({
      capabilities: {
        roots: { listChanged: false },
        sampling: {},
        elicitation: { form: {}, url: {} },
      },
    });

    const handlers = new Map<string, (...args: never[]) => unknown>();
    const client = {
      onclose: undefined,
      onerror: undefined,
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((method: string, handler: (...args: never[]) => unknown) => {
        handlers.set(method, handler);
      }),
    };
    const connection = new McpConnection('docs', client as never, undefined, broker);
    const signal = new AbortController().signal;
    await handlers.get('roots/list')?.(
      { method: 'roots/list', params: {} } as never,
      { mcpReq: { signal } } as never,
    );
    await handlers.get('sampling/createMessage')?.(
      { method: 'sampling/createMessage', params: { maxTokens: 10 } } as never,
      { mcpReq: { signal } } as never,
    );
    await handlers.get('elicitation/create')?.(
      {
        method: 'elicitation/create',
        params: { mode: 'url', url: 'https://example.com' },
      } as never,
      { mcpReq: { signal } } as never,
    );
    expect(handle).toHaveBeenNthCalledWith(1, 'docs', 'roots/list', {}, signal);
    expect(handle).toHaveBeenNthCalledWith(
      2,
      'docs',
      'sampling/createMessage',
      { maxTokens: 10 },
      signal,
    );
    expect(handle).toHaveBeenNthCalledWith(
      3,
      'docs',
      'elicitation/create',
      { mode: 'url', url: 'https://example.com' },
      signal,
    );
    expect(connection.state).toBe('connecting');
  });

  it('does not advertise or install sampling for a consent-only interaction broker', () => {
    const broker: McpInteractionBrokerPort = { handle: vi.fn() };
    expect(mcpClientOptions({ interactionBroker: broker }).capabilities).toEqual({
      roots: { listChanged: false },
      elicitation: { form: {}, url: {} },
    });
    const client = {
      onclose: undefined,
      onerror: undefined,
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
    };
    new McpConnection('docs', client as never, undefined, broker);
    expect(client.setRequestHandler).not.toHaveBeenCalledWith(
      'sampling/createMessage',
      expect.any(Function),
    );
  });

  it('does not advertise or install unsupported interaction handlers', () => {
    expect(mcpClientOptions().capabilities).toBeUndefined();
    const client = {
      onclose: undefined,
      onerror: undefined,
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
    };
    new McpConnection('docs', client as never);
    expect(client.setRequestHandler).not.toHaveBeenCalled();
  });

  it('advertises official extensions only when explicitly enabled', () => {
    expect(mcpClientOptions({}, undefined, { skills: true }).capabilities).toMatchObject({
      extensions: { 'io.modelcontextprotocol/skills': {} },
    });
    expect(mcpClientOptions({}, undefined, { tasks: true }).capabilities).toMatchObject({
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    });
    expect(mcpClientOptions({}, undefined, { apps: true }).capabilities).toMatchObject({
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
      },
    });
    expect(mcpClientOptions().capabilities).toBeUndefined();
  });

  it('enables Apps from the client opt-in without requiring a server capability echo', () => {
    const client = {
      onclose: undefined,
      onerror: undefined,
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn(),
    };
    const connection = new McpConnection('apps', client as never);
    connection.discovery = {
      protocol: { era: 'modern', version: '2026-07-28' },
      capabilities: { resources: {}, tools: {} },
      extensions: [],
    };

    connection.enableApps(true);

    expect(connection.appsEnabled).toBe(true);
  });

  it('drives MRTR with exact request state and a fresh JSON-RPC ID', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const callIds: unknown[] = [];
    const callParams: unknown[] = [];
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        });
      }
      if (message.method === 'tools/call') {
        callIds.push(message.id);
        callParams.push(message.params);
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result:
            callIds.length === 1
              ? {
                  resultType: 'input_required',
                  inputRequests: {
                    consent: {
                      method: 'elicitation/create',
                      params: {
                        mode: 'form',
                        message: 'Continue?',
                        requestedSchema: {
                          type: 'object',
                          properties: { accepted: { type: 'boolean' } },
                        },
                      },
                    },
                  },
                  requestState: 'opaque\u0000state',
                }
              : {
                  resultType: 'complete',
                  content: [{ type: 'text', text: 'done' }],
                },
        });
      }
    };
    await serverTransport.start();
    const broker: McpInteractionBrokerPort = {
      handle: vi.fn(() => Promise.resolve({ action: 'accept', content: { accepted: true } })),
    };
    const client = new Client(
      { name: 'plinthway-test', version: '1.0.0' },
      mcpClientOptions({ interactionBroker: broker }),
    );
    const connection = new McpConnection('docs', client, undefined, broker);
    await client.connect(clientTransport, { timeout: 1_000 });
    connection.markReady();

    await expect(
      connection.callTool('interactive', { value: 1 }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(callIds).toHaveLength(2);
    expect(callIds[1]).not.toBe(callIds[0]);
    expect(callParams[1]).toMatchObject({
      name: 'interactive',
      arguments: { value: 1 },
      requestState: 'opaque\u0000state',
      inputResponses: {
        consent: { action: 'accept', content: { accepted: true } },
      },
    });
    await connection.close();
    await serverTransport.close();
  });

  it('stops MRTR after eight input-required rounds', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let calls = 0;
    serverTransport.onmessage = (message) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === 'server/discover') {
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        });
      }
      if (message.method === 'tools/call') {
        calls += 1;
        void serverTransport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resultType: 'input_required',
            inputRequests: { roots: { method: 'roots/list', params: {} } },
            requestState: `round-${String(calls)}`,
          },
        });
      }
    };
    await serverTransport.start();
    const handle = vi.fn(() => Promise.resolve({ roots: [] }));
    const broker: McpInteractionBrokerPort = { handle };
    const client = new Client(
      { name: 'plinthway-test', version: '1.0.0' },
      mcpClientOptions({ interactionBroker: broker }),
    );
    const connection = new McpConnection('docs', client, undefined, broker);
    await client.connect(clientTransport, { timeout: 1_000 });
    connection.markReady();

    await expect(
      connection.callTool('interactive', {}, { timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    expect(calls).toBe(9);
    expect(handle).toHaveBeenCalledTimes(8);
    await connection.close();
    await serverTransport.close();
  });
});
