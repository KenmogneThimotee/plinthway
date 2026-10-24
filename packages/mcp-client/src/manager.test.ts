import { describe, expect, it, vi } from 'vitest';

import { PlinthwayError, sha256, type PublicMcpServerConfig } from '@plinthway/shared';

import type {
  ConnectMcpServerOptions,
  McpConnectionPort,
  McpHostEvent,
  McpPersistedTask,
  McpTaskExecution,
  McpTaskRepositoryPort,
  NativeMcpTool,
} from './contracts.js';
import { McpManager } from './manager.js';
import type { McpOAuthController } from './oauth-provider.js';

function server(id: string): PublicMcpServerConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [], env: [] };
}

function connection(
  serverId: string,
  tools: readonly NativeMcpTool[] = [
    {
      name: 'echo',
      description: 'Echo input',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
  ],
): McpConnectionPort {
  return {
    serverId,
    state: 'ready',
    listTools: () => Promise.resolve(tools),
    callTool: vi.fn((_name, argumentsValue) =>
      Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(argumentsValue) }] }),
    ),
    close: vi.fn(() => Promise.resolve()),
  };
}

class MemoryTaskRepository implements McpTaskRepositoryPort {
  readonly tasks = new Map<string, McpPersistedTask>();

  upsert(task: McpPersistedTask): Promise<void> {
    this.tasks.set(
      `${task.profileGenerationId}:${task.serverId}:${task.reference.taskId}`,
      structuredClone(task),
    );
    return Promise.resolve();
  }

  get(
    serverId: string,
    taskId: string,
    profileGenerationId: string,
  ): Promise<McpPersistedTask | undefined> {
    return Promise.resolve(this.tasks.get(`${profileGenerationId}:${serverId}:${taskId}`));
  }

  list(profileGenerationId?: string): Promise<readonly McpPersistedTask[]> {
    return Promise.resolve(
      [...this.tasks.values()].filter(
        (task) =>
          profileGenerationId === undefined || task.profileGenerationId === profileGenerationId,
      ),
    );
  }

  delete(serverId: string, taskId: string, profileGenerationId: string): Promise<void> {
    this.tasks.delete(`${profileGenerationId}:${serverId}:${taskId}`);
    return Promise.resolve();
  }
}

function taskExecution(status: 'completed' | 'cancelled' = 'completed'): McpTaskExecution {
  const task = {
    taskId: 'task-1',
    status,
    createdAt: '2026-10-18T00:00:00.000Z',
    lastUpdatedAt: '2026-10-18T00:00:01.000Z',
    retentionMs: 60_000,
    suggestedPollIntervalMs: 10,
    raw: { taskId: 'task-1', status },
  } as const;
  return {
    kind: 'task',
    reference: {
      endpointId: 'endpoint-1',
      generation: 'v2',
      taskId: 'task-1',
      originalOperation: 'tools/call',
    },
    updates: () => ({ async *[Symbol.asyncIterator]() {} }),
    settle: async (options) => {
      await options?.onEvent?.({ type: 'task', task });
      return status === 'completed'
        ? {
            status,
            task,
            result: { content: [{ type: 'text', text: 'ready' }] },
          }
        : { status, task };
    },
    cancel: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe('McpManager', () => {
  it('clears private response cache state after an OAuth principal changes', async () => {
    const oauth = {
      authorize: vi.fn().mockResolvedValue({ state: 'authorized' as const }),
    } as unknown as McpOAuthController;
    const manager = new McpManager({ connect: vi.fn(), oauth });
    manager.responseCache.set(
      { method: 'resources/read', partition: 'profile-a:docs' },
      { value: '{"secret":true}', scope: 'private' },
    );

    await expect(manager.authorize('docs')).resolves.toEqual({ state: 'authorized' });
    expect(manager.responseCache.sizeBytes).toBe(0);
  });

  it('reconnects after browser OAuth authorization completes', async () => {
    let completeAuthorization: (() => void) | undefined;
    const authorizationCompleted = new Promise<void>((resolve) => {
      completeAuthorization = resolve;
    });
    const oauth = {
      authorize: vi.fn().mockResolvedValue({
        state: 'redirect' as const,
        authorizationUrl: 'https://issuer.example.com/authorize',
        waitForCompletion: () => authorizationCompleted,
      }),
    } as unknown as McpOAuthController;
    let completeReconnect: ((value: McpConnectionPort) => void) | undefined;
    const reconnectCompleted = new Promise<McpConnectionPort>((resolve) => {
      completeReconnect = resolve;
    });
    const connect = vi
      .fn<(configured: PublicMcpServerConfig) => Promise<McpConnectionPort>>()
      .mockImplementationOnce((configured) => Promise.resolve(connection(configured.id)))
      .mockImplementationOnce(() => reconnectCompleted);
    const manager = new McpManager({ connect, oauth });
    await manager.prepare([server('docs')]);
    await manager.commit();
    manager.responseCache.set(
      { method: 'resources/read', partition: 'profile-a:docs' },
      { value: '{"secret":true}', scope: 'private' },
    );

    const started = await manager.authorize('docs');
    expect(started.state).toBe('redirect');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(manager.responseCache.sizeBytes).toBeGreaterThan(0);

    completeAuthorization?.();
    let completionSettled = false;
    const completion = started.waitForCompletion?.().then(() => {
      completionSettled = true;
    });
    let secondCompletionSettled = false;
    const secondCompletion = started.waitForCompletion?.().then(() => {
      secondCompletionSettled = true;
    });

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(2);
    });
    expect(completionSettled).toBe(false);
    expect(secondCompletionSettled).toBe(false);
    completeReconnect?.(connection('docs'));
    await Promise.all([completion, secondCompletion]);
    expect(manager.responseCache.sizeBytes).toBe(0);
  });

  it('discovers Apps while keeping app-only tools out of the model catalog', async () => {
    const appConnection = connection('widgets', [
      {
        name: 'render',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
      {
        name: 'shared',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/shared' } },
      },
    ]);
    Object.assign(appConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: {
          tools: {},
          resources: {},
          extensions: { 'io.modelcontextprotocol/ui': {} },
        },
        extensions: ['io.modelcontextprotocol/ui'],
      },
      readResource: vi.fn(),
    });
    const manager = new McpManager({ connect: vi.fn(() => Promise.resolve(appConnection)) });

    await manager.prepare([server('widgets')]);
    await manager.commit();

    expect(manager.listTools().map((tool) => tool.name)).toEqual(['widgets.shared']);
    expect(manager.listApps().map((app) => app.qualifiedName)).toEqual([
      'widgets.render',
      'widgets.shared',
    ]);
  });

  it('exposes every app-visible server helper without making app-only tools model-visible', async () => {
    const appConnection = connection('widgets', [
      {
        name: 'render',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
      {
        name: 'helper',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
        meta: { ui: { visibility: ['app'] } },
      },
    ]);
    Object.assign(appConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, resources: {} },
        extensions: [],
      },
      readResource: vi.fn(() =>
        Promise.resolve({
          contents: [
            {
              uri: 'ui://widgets/render',
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><p>Widget</p>',
            },
          ],
        }),
      ),
    });
    const manager = new McpManager({ connect: vi.fn(() => Promise.resolve(appConnection)) });
    await manager.prepare([server('widgets')], [], 'generation-1', {
      defaultPolicy: 'allow',
      rules: [],
    });

    expect(manager.listPreparedTools().map((tool) => tool.name)).toEqual([
      'widgets.helper',
      'widgets.render',
    ]);

    await manager.commit();
    expect(manager.listTools()).toEqual([]);
    expect(manager.listApps().map((app) => app.qualifiedName)).toEqual(['widgets.render']);
    const session = await manager.openApp('widgets.render', { auditSessionId: 'session-1' });
    try {
      const bridge = (value: unknown) =>
        fetch(`${session.proxyOrigin}/bridge`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
            Origin: session.proxyOrigin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(value),
        });
      const listed = await bridge({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await expect(listed.json()).resolves.toMatchObject({
        result: { tools: [{ name: 'helper' }, { name: 'render' }] },
      });
      const called = await bridge({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'helper', arguments: {} },
      });
      expect(called.status).toBe(200);
      expect(appConnection.callTool).toHaveBeenCalledWith(
        'helper',
        {},
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
    } finally {
      await manager.disconnect();
    }
  });

  it('requires approval for App-origin tool calls and closes renderers on disconnect', async () => {
    const approveApp = vi.fn().mockResolvedValue(true);
    const appConnection = connection('widgets', [
      {
        name: 'render',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: 'string' } },
        },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
    ]);
    Object.assign(appConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: {
          tools: {},
          resources: {},
          extensions: { 'io.modelcontextprotocol/ui': {} },
        },
        extensions: ['io.modelcontextprotocol/ui'],
      },
      readResource: vi.fn(() =>
        Promise.resolve({
          contents: [
            {
              uri: 'ui://widgets/render',
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><p>Widget</p>',
            },
          ],
        }),
      ),
      listResources: vi.fn(() =>
        Promise.resolve([
          {
            uri: 'ui://widgets/render',
            name: 'Render App',
            meta: { ui: { permissions: { geolocation: {} } } },
          },
        ]),
      ),
    });
    const manager = new McpManager({
      connect: vi.fn(() => Promise.resolve(appConnection)),
      approveApp,
    });
    await manager.prepare([server('widgets')]);
    await manager.commit();
    const session = await manager.openApp('widgets.render', { auditSessionId: 'session-1' });
    try {
      const appResource = await fetch(`${session.proxyOrigin}/resource`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      await expect(appResource.json()).resolves.toMatchObject({
        permissions: { geolocation: {} },
      });
      const response = await fetch(`${session.proxyOrigin}/bridge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Origin: session.proxyOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'render', arguments: { city: 'Paris' } },
        }),
      });
      expect(response.status).toBe(200);
      expect(approveApp).toHaveBeenCalledWith({
        appSessionId: session.id,
        auditSessionId: 'session-1',
        callId: '1',
        profileGenerationId: 'unscoped',
        readOnlyHint: false,
        serverId: 'widgets',
        toolName: 'render',
        resourceUri: 'ui://widgets/render',
        arguments: { city: 'Paris' },
      });
      expect(appConnection.callTool).toHaveBeenCalledWith(
        'render',
        { city: 'Paris' },
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
      await manager.prepare([server('widgets')], [], 'denied-generation', {
        defaultPolicy: 'deny',
        rules: [],
      });
      await manager.commit();
      expect(session.closed).toBe(true);
      await expect(fetch(session.origin)).rejects.toThrow();

      const deniedSession = await manager.openApp('widgets.render', {
        auditSessionId: 'session-1',
      });
      const denied = await fetch(`${deniedSession.proxyOrigin}/bridge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deniedSession.token}`,
          Origin: deniedSession.proxyOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'render', arguments: { city: 'Paris' } },
        }),
      });
      expect(denied.status).toBe(403);
      const deniedPayload = (await denied.json()) as {
        readonly id: number;
        readonly error: { readonly code: number; readonly message: string };
      };
      expect(deniedPayload.id).toBe(2);
      expect(deniedPayload.error.code).toBe(-32001);
      expect(deniedPayload.error.message).toMatch(/denied by policy/u);
      expect(approveApp).toHaveBeenCalledTimes(1);
    } finally {
      await manager.disconnect();
    }
  });

  it('serializes App approvals and rejects approved calls after a generation switch', async () => {
    const approvalResolvers: Array<(approved: boolean) => void> = [];
    const approveApp = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          approvalResolvers.push(resolve);
        }),
    );
    const appConnection = connection('widgets', [
      {
        name: 'render',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
    ]);
    Object.assign(appConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, resources: {} },
        extensions: [],
      },
      readResource: vi.fn(() =>
        Promise.resolve({
          contents: [
            {
              uri: 'ui://widgets/render',
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><p>Widget</p>',
            },
          ],
        }),
      ),
    });
    const manager = new McpManager({
      connect: vi.fn(() => Promise.resolve(appConnection)),
      approveApp,
    });
    await manager.prepare([server('widgets')]);
    await manager.commit();
    const session = await manager.openApp('widgets.render', { auditSessionId: 'session-1' });
    const request = (id: number) =>
      fetch(`${session.proxyOrigin}/bridge`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Origin: session.proxyOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'render', arguments: {} },
        }),
      });
    const first = request(1).catch(() => undefined);
    const second = request(2).catch(() => undefined);
    await vi.waitFor(() => {
      expect(approveApp).toHaveBeenCalledTimes(1);
    });

    approvalResolvers[0]?.(true);
    await vi.waitFor(() => {
      expect(approveApp).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(appConnection.callTool).toHaveBeenCalledTimes(1);
    });
    await manager.prepare([server('widgets')], [], 'next-generation');
    await manager.commit();
    approvalResolvers[1]?.(true);
    await Promise.all([first, second]);

    expect(appConnection.callTool).toHaveBeenCalledTimes(1);
    await manager.disconnect();
  });

  it('waits for in-flight App tools before committing a profile generation', async () => {
    let finishCall: ((value: { readonly content: readonly unknown[] }) => void) | undefined;
    const tools: readonly NativeMcpTool[] = [
      {
        name: 'render',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
    ];
    const first = connection('widgets', tools);
    Object.assign(first, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, resources: {} },
        extensions: [],
      },
      readResource: vi.fn(() =>
        Promise.resolve({
          contents: [
            {
              uri: 'ui://widgets/render',
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><p>Widget</p>',
            },
          ],
        }),
      ),
      callTool: vi.fn(
        () =>
          new Promise<{ readonly content: readonly unknown[] }>((resolve) => {
            finishCall = resolve;
          }),
      ),
    });
    const second = connection('widgets', tools);
    Object.assign(second, {
      appsEnabled: true,
      discovery: first.discovery,
      readResource: first.readResource,
    });
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new McpManager({ connect });
    await manager.prepare([server('widgets')], [], 'first', {
      defaultPolicy: 'allow',
      rules: [{ tool: 'widgets.render', action: 'allow' }],
    });
    await manager.commit();
    const session = await manager.openApp('widgets.render', { auditSessionId: 'session-1' });
    const request = fetch(`${session.proxyOrigin}/bridge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        Origin: session.proxyOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'render', arguments: {} },
      }),
    }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(first.callTool).toHaveBeenCalledOnce();
    });

    await manager.prepare([server('widgets')], [], 'second');
    let committed = false;
    const committing = manager.commit().then(() => {
      committed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(committed).toBe(false);
    expect(first.close).not.toHaveBeenCalled();

    finishCall?.({ content: [{ type: 'text', text: 'done' }] });
    await committing;
    await request;
    expect(first.close).toHaveBeenCalledOnce();
    await manager.disconnect();
  });

  it('closes an App whose resource read finishes after its profile was superseded', async () => {
    let finishRead: ((value: { readonly contents: readonly unknown[] }) => void) | undefined;
    const firstConnection = connection('widgets', [
      {
        name: 'render',
        inputSchema: { type: 'object' },
        meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
      },
    ]);
    Object.assign(firstConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, resources: {} },
        extensions: [],
      },
      readResource: vi.fn(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      ),
    });
    const secondConnection = connection('widgets', []);
    const connect = vi
      .fn()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    const manager = new McpManager({ connect });
    await manager.prepare([server('widgets')]);
    await manager.commit();
    const opening = manager.openApp('widgets.render', { auditSessionId: 'session-1' });
    await vi.waitFor(() => {
      expect(firstConnection.readResource).toHaveBeenCalledTimes(1);
    });
    await manager.prepare([server('widgets')], [], 'next-generation');
    await manager.commit();
    finishRead?.({
      contents: [
        {
          uri: 'ui://widgets/render',
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html><p>Late</p>',
        },
      ],
    });

    await expect(opening).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    expect(manager.listAppSessions()).toEqual([]);
    await manager.disconnect();
  });

  it('keeps the previous App catalog when a list-changed refresh is malformed', async () => {
    let listener: ((event: McpHostEvent) => void) | undefined;
    const initial = {
      name: 'render',
      inputSchema: { type: 'object' },
      meta: { ui: { resourceUri: 'ui://widgets/render', visibility: ['app'] } },
    } as const;
    const listTools = vi
      .fn<() => Promise<readonly NativeMcpTool[]>>()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([{ ...initial, meta: { ui: { resourceUri: 'https://invalid' } } }]);
    const appConnection = connection('widgets');
    Object.assign(appConnection, {
      appsEnabled: true,
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, resources: {} },
        extensions: [],
      },
      listTools,
      onEvent: vi.fn((next: (event: McpHostEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    });
    const manager = new McpManager({ connect: vi.fn(() => Promise.resolve(appConnection)) });
    await manager.prepare([server('widgets')]);
    await manager.commit();
    listener?.({
      type: 'catalog-changed',
      serverId: 'widgets',
      catalog: 'tools',
    });
    await vi.waitFor(() => {
      expect(listTools).toHaveBeenCalledTimes(2);
    });

    expect(manager.listApps().map((app) => app.qualifiedName)).toEqual(['widgets.render']);
    await manager.disconnect();
  });
  it('namespaces duplicate native names and exposes only committed servers', async () => {
    const connections = new Map([
      ['files', connection('files')],
      ['git', connection('git')],
    ]);
    const manager = new McpManager({
      connect: (config) => {
        const selected = connections.get(config.id);
        return selected === undefined
          ? Promise.reject(new Error(`missing ${config.id}`))
          : Promise.resolve(selected);
      },
    });

    await manager.prepare([server('files'), server('git')]);
    expect(manager.listTools()).toEqual([]);
    await manager.commit();
    expect(manager.listTools().map((tool) => tool.name)).toEqual(['files.echo', 'git.echo']);
    expect(manager.responseCache.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  it('shares a bounded cache while partitioning connector contexts by server and profile generation', async () => {
    const receivedOptions: ConnectMcpServerOptions[] = [];
    const connect = vi.fn((config: PublicMcpServerConfig, ...rest: [ConnectMcpServerOptions?]) => {
      if (rest[0] !== undefined) receivedOptions.push(rest[0]);
      return Promise.resolve(connection(config.id));
    });
    const manager = new McpManager({ connect });
    await manager.prepare([server('files'), server('git')], [], 'generation-a');

    const firstOptions = receivedOptions[0];
    const secondOptions = receivedOptions[1];
    expect(manager.interactions).toBeDefined();
    expect(firstOptions?.responseCacheStore).toBe(manager.responseCache);
    expect(secondOptions?.responseCacheStore).toBe(manager.responseCache);
    expect(firstOptions?.interactionBroker).toBe(manager.interactions);
    expect(secondOptions?.interactionBroker).toBe(manager.interactions);
    expect(firstOptions?.cachePartition).not.toBe(secondOptions?.cachePartition);
    await manager.rollback();

    await manager.prepare([server('files')], [], 'generation-b');
    expect(receivedOptions[2]?.cachePartition).not.toBe(firstOptions?.cachePartition);
    await manager.rollback();
  });

  it('preserves complete tool and call-result metadata', async () => {
    const active: McpConnectionPort = {
      ...connection('docs', [
        {
          name: 'search',
          title: 'Search docs',
          description: 'Search documentation',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          annotations: {
            title: 'Search docs',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          icons: [{ src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml' }],
          meta: { category: 'knowledge' },
        },
      ]),
      callTool: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'one match' }],
          structuredContent: { hits: [{ title: 'MCP' }] },
          meta: { traceId: 'trace-1' },
        }),
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('docs')]);
    await manager.commit();

    expect(manager.listTools()[0]).toMatchObject({
      title: 'Search docs',
      outputSchema: { type: 'object' },
      icons: [{ src: 'https://example.com/icon.svg' }],
      meta: { category: 'knowledge' },
    });
    await expect(manager.invoke('docs.search', {}, { timeoutMs: 100 })).resolves.toMatchObject({
      structuredContent: { hits: [{ title: 'MCP' }] },
      meta: { traceId: 'trace-1' },
    });
  });

  it('persists and drives task-backed tools through terminal state', async () => {
    const tasks = new MemoryTaskRepository();
    const active: McpConnectionPort = {
      ...connection('reports', [
        {
          name: 'generate',
          inputSchema: { type: 'object' },
          taskSupport: 'optional',
        },
      ]),
      tasksEnabled: true,
      callToolTask: vi.fn(() => Promise.resolve(taskExecution())),
    };
    const manager = new McpManager({
      connect: () => Promise.resolve(active),
      taskRepository: tasks,
      now: () => new Date('2026-10-18T00:00:02.000Z'),
    });
    await manager.prepare([server('reports')], [], 'generation-a');
    await manager.commit();

    await expect(
      manager.invoke('reports.generate', {}, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'ready' }] });

    await expect(
      manager.startTask('reports.generate', {}, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      kind: 'task',
      task: {
        profileGenerationId: 'generation-a',
        reference: { taskId: 'task-1' },
      },
    });
    await vi.waitFor(async () => {
      await expect(tasks.get('reports', 'task-1', 'generation-a')).resolves.toMatchObject({
        status: 'completed',
        task: { suggestedPollIntervalMs: 10 },
        result: { content: [{ type: 'text', text: 'ready' }] },
        expiresAt: '2026-10-18T00:01:00.000Z',
      });
    });
    expect(manager.listEvents()).toContainEqual(
      expect.objectContaining({ type: 'task-updated', serverId: 'reports' }),
    );
  });

  it('resumes non-terminal tasks only for the active profile generation', async () => {
    const tasks = new MemoryTaskRepository();
    const record: McpPersistedTask = {
      serverId: 'reports',
      profileGenerationId: 'generation-a',
      toolName: 'reports.generate',
      reference: {
        endpointId: 'endpoint-1',
        generation: 'v2',
        taskId: 'task-1',
        originalOperation: 'tools/call',
      },
      status: 'working',
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    };
    await tasks.upsert(record);
    const resumeTask = vi.fn(() => Promise.resolve(taskExecution()));
    const active: McpConnectionPort = {
      ...connection('reports'),
      resumeTask,
    };
    const manager = new McpManager({
      connect: () => Promise.resolve(active),
      taskRepository: tasks,
      now: () => new Date('2026-10-18T00:00:02.000Z'),
    });
    await manager.prepare([server('reports')], [], 'generation-a');
    await manager.commit();
    expect(resumeTask).toHaveBeenCalledWith(record.reference, { timeoutMs: 30_000 });
    await vi.waitFor(async () => {
      await expect(tasks.get('reports', 'task-1', 'generation-a')).resolves.toMatchObject({
        status: 'completed',
      });
    });

    const other = new McpManager({
      connect: () => Promise.resolve(active),
      taskRepository: tasks,
    });
    await other.prepare([server('reports')], [], 'generation-b');
    await other.commit();
    expect(resumeTask).toHaveBeenCalledTimes(1);
  });

  it('does not resume task references after their retention deadline', async () => {
    const tasks = new MemoryTaskRepository();
    await tasks.upsert({
      serverId: 'reports',
      profileGenerationId: 'generation-a',
      toolName: 'reports.generate',
      reference: {
        endpointId: 'endpoint-1',
        generation: 'v2',
        taskId: 'expired',
        originalOperation: 'tools/call',
      },
      status: 'working',
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
      expiresAt: '2026-10-18T00:00:01.000Z',
    });
    const resumeTask = vi.fn();
    const manager = new McpManager({
      connect: () => Promise.resolve({ ...connection('reports'), resumeTask }),
      taskRepository: tasks,
      now: () => new Date('2026-10-18T00:00:02.000Z'),
    });
    await manager.prepare([server('reports')], [], 'generation-a');
    await manager.commit();

    expect(resumeTask).not.toHaveBeenCalled();
    await expect(tasks.get('reports', 'expired', 'generation-a')).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('aggregates and routes prompts, resources, templates, reads, and completions', async () => {
    const active: McpConnectionPort = {
      ...connection('docs'),
      discovery: {
        protocol: { era: 'modern', version: '2026-07-28' },
        capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
        extensions: [],
      },
      listPrompts: () =>
        Promise.resolve([{ name: 'summarize', arguments: [{ name: 'style', required: true }] }]),
      getPrompt: (_name, argumentsValue) =>
        Promise.resolve({
          description: 'Summary',
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: argumentsValue.style ?? '' },
            },
          ],
        }),
      listResources: () => Promise.resolve([{ uri: 'docs://guide', name: 'Guide' }]),
      listResourceTemplates: () =>
        Promise.resolve([{ uriTemplate: 'docs://{slug}', name: 'Document' }]),
      readResource: (uri) =>
        Promise.resolve({ contents: [{ uri, mimeType: 'text/plain', text: 'Guide text' }] }),
      complete: (_reference, argument) =>
        Promise.resolve({ values: [`${argument.value}-one`], total: 1, hasMore: false }),
      subscribeResource: vi.fn(() => Promise.resolve()),
      unsubscribeResource: vi.fn(() => Promise.resolve()),
      ping: vi.fn(() => Promise.resolve()),
      setLoggingLevel: vi.fn(() => Promise.resolve()),
      sendRootsListChanged: vi.fn(() => Promise.resolve()),
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('docs')]);
    await manager.commit();

    expect(manager.listPrompts()).toEqual([
      expect.objectContaining({ name: 'docs.summarize', nativeName: 'summarize' }),
    ]);
    expect(manager.listResources()).toEqual([
      expect.objectContaining({ serverId: 'docs', uri: 'docs://guide' }),
    ]);
    expect(manager.listResourceTemplates()).toEqual([
      expect.objectContaining({ serverId: 'docs', uriTemplate: 'docs://{slug}' }),
    ]);
    await expect(
      manager.getPrompt('docs.summarize', { style: 'short' }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ trusted: false, serverId: 'docs', description: 'Summary' });
    await expect(
      manager.readResource('docs', 'docs://guide', { timeoutMs: 100 }),
    ).resolves.toMatchObject({ trusted: false, serverId: 'docs', uri: 'docs://guide' });
    await expect(
      manager.completePrompt('docs.summarize', { name: 'style', value: 'sh' }, undefined, {
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ values: ['sh-one'], total: 1, hasMore: false });
    await expect(
      manager.completeResourceTemplate(
        'docs',
        'docs://{slug}',
        { name: 'slug', value: 'gui' },
        undefined,
        { timeoutMs: 100 },
      ),
    ).resolves.toEqual({ values: ['gui-one'], total: 1, hasMore: false });
    await expect(
      manager.subscribeResource('docs', 'docs://guide', { timeoutMs: 100 }),
    ).resolves.toBeUndefined();
    await expect(
      manager.unsubscribeResource('docs', 'docs://guide', { timeoutMs: 100 }),
    ).resolves.toBeUndefined();
    expect(active.subscribeResource).toHaveBeenCalledWith(
      'docs://guide',
      expect.objectContaining({ timeoutMs: 100 }),
    );
    await expect(manager.ping('docs', { timeoutMs: 100 })).resolves.toBeUndefined();
    await expect(
      manager.setLoggingLevel('docs', 'warning', { timeoutMs: 100 }),
    ).resolves.toBeUndefined();
    await expect(manager.sendRootsListChanged('docs')).resolves.toBeUndefined();
  });

  it('stages server-scoped skills and exposes only approved verified context', async () => {
    const content = '---\nname: review\ndescription: Review changes\n---\n\n# Review\n';
    const uri = 'skill://docs/review/SKILL.md';
    const entry = {
      serverId: 'docs',
      uri,
      frontmatter: { name: 'review', description: 'Review changes' },
      resources: [{ uri, digest: `sha256:${sha256(content)}`, size: Buffer.byteLength(content) }],
    } as const;
    const active: McpConnectionPort = {
      ...connection('docs'),
      skillsEnabled: true,
      directoryReadEnabled: false,
      listSkills: () => Promise.resolve([entry]),
      getSkill: () => Promise.resolve(entry),
      readSkillResource: () => Promise.resolve({ uri, bytes: Buffer.from(content) }),
      readSkillDirectory: () => Promise.resolve([]),
    };
    const approveSkill = vi.fn(() => Promise.resolve(true));
    const manager = new McpManager({
      connect: () => Promise.resolve(active),
      approveSkill,
    });

    await manager.prepare([server('docs')]);
    expect(manager.listSkills()).toEqual([]);
    await manager.commit();
    expect(manager.listSkills()).toEqual([entry]);
    await manager.activateSkill('docs', uri, { requestedBy: 'model' });
    expect(approveSkill).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'docs', uri, requestedBy: 'model' }),
    );
    expect(manager.listActiveSkillContexts()[0]).toContain('MCP SERVER ORIGIN: docs');
  });

  it('keeps healthy servers available when another server is incompatible', async () => {
    const first = connection('first');
    const manager = new McpManager({
      connect: (config) =>
        config.id === 'first'
          ? Promise.resolve(first)
          : Promise.reject(new PlinthwayError('CONFIG_INVALID', 'handshake failed')),
    });

    await manager.prepare([server('first'), server('second')]);
    expect(manager.listPreparedTools().map(({ name }) => name)).toEqual(['first.echo']);
    await manager.commit();
    expect(first.close).not.toHaveBeenCalled();
    expect(manager.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'first', state: 'ready' }),
        expect.objectContaining({ serverId: 'second', state: 'incompatible' }),
      ]),
    );
  });

  it('rejects unknown tools and invalid arguments without calling the server', async () => {
    const active = connection('files');
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('files')]);
    await manager.commit();

    await expect(manager.invoke('disabled.echo', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
    await expect(
      manager.invoke('files.echo', { text: 42 }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
    expect(active.callTool).not.toHaveBeenCalled();
  });

  it('labels bounded results as untrusted and reports degraded connections', async () => {
    const active = connection('files');
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('files')]);
    await manager.commit();

    await expect(
      manager.invoke('files.echo', { text: 'hello' }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ trusted: false, serverId: 'files', toolName: 'files.echo' });
    active.state = 'degraded';
    expect(manager.status()).toEqual([
      expect.objectContaining({ serverId: 'files', state: 'degraded' }),
    ]);
    await expect(
      manager.invoke('files.echo', { text: 'hello' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'MCP_CONNECTION_FAILED' });
  });

  it('removes stale tools while replacing a lost connection', async () => {
    vi.useFakeTimers();
    let notify: ((state: McpConnectionPort['state']) => void) | undefined;
    const first: McpConnectionPort = {
      ...connection('files'),
      onStateChange: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const replacement = connection('files');
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const manager = new McpManager({ connect, retryBaseMs: 1, retryMaxMs: 1, random: () => 0.5 });
    try {
      await manager.prepare([server('files')]);
      await manager.commit();
      expect(manager.listTools()).toHaveLength(1);

      first.state = 'degraded';
      notify?.('degraded');
      expect(manager.listTools()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.listTools()).toHaveLength(1);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      await manager.disconnect();
      vi.useRealTimers();
    }
  });

  it('forwards host events and atomically refreshes a changed catalog', async () => {
    let notifyEvent: Parameters<NonNullable<McpConnectionPort['onEvent']>>[0] | undefined;
    let tools: readonly NativeMcpTool[] = [{ name: 'before', inputSchema: { type: 'object' } }];
    const active: McpConnectionPort = {
      ...connection('docs'),
      listTools: () => Promise.resolve(tools),
      onEvent: (listener) => {
        notifyEvent = listener;
        return () => {
          notifyEvent = undefined;
        };
      },
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    const events: unknown[] = [];
    manager.onEvent((event) => events.push(event));
    await manager.prepare([server('docs')]);
    await manager.commit();

    tools = [{ name: 'after', inputSchema: { type: 'object' } }];
    notifyEvent?.({ type: 'catalog-changed', serverId: 'docs', catalog: 'tools' });
    await vi.waitFor(() => {
      expect(manager.listTools().map(({ name }) => name)).toEqual(['docs.after']);
    });
    notifyEvent?.({ type: 'resource-updated', serverId: 'docs', uri: 'docs://guide' });
    expect(events).toEqual([
      { type: 'catalog-changed', serverId: 'docs', catalog: 'tools' },
      { type: 'resource-updated', serverId: 'docs', uri: 'docs://guide' },
    ]);
  });

  it('rejects oversized result blocks', async () => {
    const active: McpConnectionPort = {
      ...connection('files'),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] }),
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('files')]);
    await manager.commit();

    await expect(
      manager.invoke('files.echo', { text: 'hello' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects oversized aggregate results even when each block is under its limit', async () => {
    const active: McpConnectionPort = {
      ...connection('files'),
      callTool: () =>
        Promise.resolve({
          content: Array.from({ length: 3 }, () => ({
            type: 'text',
            text: 'x'.repeat(800_000),
          })),
        }),
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('files')]);
    await manager.commit();

    await expect(
      manager.invoke('files.echo', { text: 'hello' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects prompt and resource payloads larger than 16 MiB', async () => {
    const active: McpConnectionPort = {
      ...connection('docs'),
      listPrompts: () => Promise.resolve([{ name: 'huge' }]),
      getPrompt: () =>
        Promise.resolve({ messages: [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024) }] }),
      listResources: () => Promise.resolve([{ uri: 'docs://huge', name: 'Huge' }]),
      readResource: () =>
        Promise.resolve({ contents: [{ uri: 'docs://huge', blob: 'x'.repeat(16 * 1024 * 1024) }] }),
    };
    const manager = new McpManager({ connect: () => Promise.resolve(active) });
    await manager.prepare([server('docs')]);
    await manager.commit();

    await expect(manager.getPrompt('docs.huge', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    await expect(
      manager.readResource('docs', 'docs://huge', { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
