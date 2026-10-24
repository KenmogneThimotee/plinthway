import {
  McpManager,
  type McpConnectionPort,
  type McpHostEvent,
} from '../../packages/mcp-client/src/index.js';
import { PlinthwayError, type PublicMcpServerConfig } from '../../packages/shared/src/index.js';
import { describe, expect, it, vi } from 'vitest';

function server(id: string): PublicMcpServerConfig {
  return { id, transport: 'stdio', command: process.execPath, args: [], env: [] };
}

interface ControlledConnection extends McpConnectionPort {
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly setTool: (name: string) => void;
  readonly emitCatalogChange: () => void;
  readonly emitState: (state: McpConnectionPort['state']) => void;
}

function controlledConnection(serverId: string, initialTool = 'echo'): ControlledConnection {
  let tool = initialTool;
  let eventListener: ((event: McpHostEvent) => void) | undefined;
  let stateListener: ((state: McpConnectionPort['state']) => void) | undefined;
  const value: ControlledConnection = {
    serverId,
    state: 'ready',
    discovery: {
      protocol: { era: 'modern', version: '2026-07-28' },
      capabilities: { tools: { listChanged: true } },
      extensions: [],
    },
    listTools: () => Promise.resolve([{ name: tool, inputSchema: { type: 'object' } }]),
    callTool: () => Promise.resolve({ content: [] }),
    close: vi.fn(() => Promise.resolve()),
    onEvent: (listener) => {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
    onStateChange: (listener) => {
      stateListener = listener;
      return () => {
        stateListener = undefined;
      };
    },
    setTool: (name) => {
      tool = name;
    },
    emitCatalogChange: () => {
      eventListener?.({ type: 'catalog-changed', serverId, catalog: 'tools' });
    },
    emitState: (state) => {
      value.state = state;
      stateListener?.(state);
    },
  };
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('25-server MCP lifecycle', () => {
  it('bounds activation, tolerates failures, refreshes catalogs, reconnects, replaces profiles, and cleans up', async () => {
    const allConnections: ControlledConnection[] = [];
    const attempts = new Map<string, number>();
    const late = deferred<McpConnectionPort>();
    let active = 0;
    let maximum = 0;
    const connect = vi.fn(async (config: PublicMcpServerConfig) => {
      const attempt = (attempts.get(config.id) ?? 0) + 1;
      attempts.set(config.id, attempt);
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (config.id === 'server-23') {
          throw new PlinthwayError('CONFIG_INVALID', 'fixture is incompatible');
        }
        if (config.id === 'server-24' && attempt === 1) return await late.promise;
        await Promise.resolve();
        const connection = controlledConnection(config.id, attempt === 1 ? 'echo' : 'reconnected');
        allConnections.push(connection);
        return connection;
      } finally {
        active -= 1;
      }
    });
    const manager = new McpManager({
      connect,
      maxConcurrent: 8,
      activationTimeoutMs: 50,
      retryBaseMs: 100,
      retryMaxMs: 100,
      random: () => 0.5,
    });

    try {
      await manager.prepare(
        Array.from({ length: 25 }, (_, index) => server(`server-${String(index)}`)),
        [],
        'generation-1',
      );
      await manager.commit();

      expect(maximum).toBe(8);
      expect(manager.listTools()).toHaveLength(23);
      expect(manager.status()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ serverId: 'server-23', state: 'incompatible' }),
          expect.objectContaining({ serverId: 'server-24', state: 'connecting' }),
        ]),
      );

      await vi.waitFor(() => {
        expect(manager.status()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ serverId: 'server-24', state: 'reconnecting' }),
          ]),
        );
      });
      const lateConnection = controlledConnection('server-24', 'late');
      late.resolve(lateConnection);
      await vi.waitFor(() => {
        expect(lateConnection.close).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(manager.status()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ serverId: 'server-24', state: 'ready' }),
          ]),
        );
      });

      const catalogConnection = allConnections.find(({ serverId }) => serverId === 'server-1');
      if (catalogConnection === undefined) throw new Error('missing catalog fixture');
      catalogConnection.setTool('updated');
      catalogConnection.emitCatalogChange();
      await vi.waitFor(() => {
        expect(manager.listTools().map(({ name }) => name)).toContain('server-1.updated');
      });
      expect(manager.listTools().map(({ name }) => name)).not.toContain('server-1.echo');

      const reconnecting = allConnections.find(({ serverId }) => serverId === 'server-0');
      if (reconnecting === undefined) throw new Error('missing reconnect fixture');
      reconnecting.emitState('degraded');
      expect(manager.listTools().map(({ name }) => name)).not.toContain('server-0.echo');
      await vi.waitFor(() => {
        expect(manager.listTools().map(({ name }) => name)).toContain('server-0.reconnected');
      });
      expect(reconnecting.close).toHaveBeenCalledOnce();

      const previousGeneration = [...allConnections];
      await manager.prepare(
        Array.from({ length: 25 }, (_, index) => server(`next-${String(index)}`)),
        [],
        'generation-2',
      );
      expect(manager.listTools().some(({ serverId }) => serverId.startsWith('server-'))).toBe(true);
      await manager.commit();
      expect(manager.listTools()).toHaveLength(25);
      expect(manager.listTools().every(({ serverId }) => serverId.startsWith('next-'))).toBe(true);
      expect(previousGeneration.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
    } finally {
      await manager.disconnect();
    }

    expect(allConnections.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
  });
});
