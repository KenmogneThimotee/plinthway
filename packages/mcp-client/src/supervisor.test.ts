import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/client';

import { PlinthwayError, type PublicMcpServerConfig } from '@plinthway/shared';

import type { McpConnectionPort } from './contracts.js';
import { mapConnectionError } from './connection.js';
import { McpSupervisor } from './supervisor.js';

function server(id: string): PublicMcpServerConfig {
  return { id, transport: 'stdio', command: 'fixture', args: [], env: [] };
}

function connection(serverId: string): McpConnectionPort {
  return {
    serverId,
    state: 'ready',
    discovery: {
      protocol: { era: 'modern', version: '2026-07-28' },
      capabilities: { tools: {} },
      extensions: [],
    },
    listTools: () => Promise.resolve([]),
    callTool: () => Promise.resolve({ content: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('McpSupervisor', () => {
  it('connects no more than eight servers concurrently', async () => {
    const pending = Array.from({ length: 25 }, () => deferred<McpConnectionPort>());
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const supervisor = new McpSupervisor({
      connect: () => {
        const current = calls++;
        active += 1;
        maximum = Math.max(maximum, active);
        const selected = pending[current];
        if (selected === undefined) throw new Error('missing deferred connection');
        return selected.promise.finally(() => {
          active -= 1;
        });
      },
    });

    const preparing = supervisor.prepare(
      Array.from({ length: 25 }, (_, index) => server(`server-${String(index)}`)),
    );
    await vi.waitFor(() => {
      expect(calls).toBe(8);
    });
    const first = pending[0];
    if (first === undefined) throw new Error('missing first deferred connection');
    first.resolve(connection('server-0'));
    await vi.waitFor(() => {
      expect(calls).toBe(9);
    });
    expect(maximum).toBe(8);
    for (let index = 1; index < pending.length; index += 1) {
      const selected = pending[index];
      if (selected === undefined) throw new Error('missing deferred connection');
      selected.resolve(connection(`server-${String(index)}`));
    }
    const generation = await preparing;
    expect(generation.connections).toHaveLength(25);
    await generation.close();
  });

  it('returns a partial generation at the ten-second activation budget', async () => {
    vi.useFakeTimers();
    const hung = deferred<McpConnectionPort>();
    const onConnection = vi.fn();
    const supervisor = new McpSupervisor({
      connect: (config) =>
        config.id === 'ready' ? Promise.resolve(connection('ready')) : hung.promise,
    });

    const preparing = supervisor.prepare([server('ready'), server('hung')], { onConnection });
    await vi.advanceTimersByTimeAsync(10_000);
    const generation = await preparing;
    expect(generation.connections.map(({ serverId }) => serverId)).toEqual(['ready']);
    expect(generation.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'ready', state: 'ready' }),
        expect.objectContaining({ serverId: 'hung', state: 'reconnecting' }),
      ]),
    );

    expect(onConnection).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'ready' }),
      expect.any(Number),
    );
    await generation.close();
  });

  it('classifies failures and retries retryable errors with bounded backoff', async () => {
    vi.useFakeTimers();
    const ready = connection('retrying');
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new PlinthwayError('MCP_CONNECTION_FAILED', 'offline'))
      .mockResolvedValueOnce(ready);
    const supervisor = new McpSupervisor({ connect, random: () => 0.5 });
    const generation = await supervisor.prepare([server('retrying')]);
    expect(generation.status()[0]).toMatchObject({ state: 'reconnecting' });

    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(generation.status()[0]).toMatchObject({ state: 'ready' });

    const incompatible = new McpSupervisor({
      connect: () => Promise.reject(new PlinthwayError('CONFIG_INVALID', 'bad config')),
    });
    const invalid = await incompatible.prepare([server('invalid')]);
    expect(invalid.status()[0]).toMatchObject({ state: 'incompatible' });
    await vi.runAllTimersAsync();
    await generation.close();
    await invalid.close();
  });

  it('stops reconnecting when interactive OAuth requires authorization', async () => {
    vi.useFakeTimers();
    const connect = vi.fn(() =>
      Promise.reject(
        mapConnectionError(
          'secure',
          new UnauthorizedError('Authentication requires user authorization'),
        ),
      ),
    );
    const generation = await new McpSupervisor({ connect, random: () => 0.5 }).prepare([
      server('secure'),
    ]);

    expect(generation.status()[0]).toMatchObject({
      state: 'auth-required',
      authorization: { state: 'required' },
      lastError: { code: 'AUTH_FAILED', retryable: false },
    });
    expect(generation.status()[0]).not.toHaveProperty('retryAt');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledOnce();
    await generation.close();
  });

  it('removes a degraded connection and replaces it without crossing generations', async () => {
    vi.useFakeTimers();
    let notify: ((state: McpConnectionPort['state']) => void) | undefined;
    const first = {
      ...connection('live'),
      onStateChange: (listener: (state: McpConnectionPort['state']) => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const replacement = connection('live');
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const onConnection = vi.fn();
    const onDisconnection = vi.fn();
    const supervisor = new McpSupervisor({ connect, random: () => 0.5 });
    const generation = await supervisor.prepare([server('live')], {
      onConnection,
      onDisconnection,
    });

    first.state = 'degraded';
    notify?.('degraded');
    expect(generation.connections).toEqual([]);
    expect(onDisconnection).toHaveBeenCalledWith(first, generation.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generation.connections).toEqual([replacement]);
    expect(onConnection).toHaveBeenCalledTimes(2);
    await generation.close();
  });

  it('coalesces repeated reconnect requests while a connection attempt is in flight', async () => {
    const replacement = deferred<McpConnectionPort>();
    const first = connection('live');
    const connect = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(replacement.promise);
    const generation = await new McpSupervisor({ connect }).prepare([server('live')]);

    void generation.reconnect('live');
    void generation.reconnect('live');
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(2);
    });
    replacement.resolve(connection('live'));
    await vi.waitFor(() => {
      expect(generation.status()[0]).toMatchObject({ state: 'ready' });
    });
    expect(connect).toHaveBeenCalledTimes(2);
    await generation.close();
  });

  it('observes a disconnect that occurs while catalogs are being refreshed', async () => {
    vi.useFakeTimers();
    const refreshed = deferred<undefined>();
    let notify: ((state: McpConnectionPort['state']) => void) | undefined;
    const candidate = {
      ...connection('live'),
      onStateChange: (listener: (state: McpConnectionPort['state']) => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const onDisconnection = vi.fn();
    const preparing = new McpSupervisor({
      connect: () => Promise.resolve(candidate),
      random: () => 0.5,
    }).prepare([server('live')], {
      onConnection: () => refreshed.promise,
      onDisconnection,
    });
    await vi.waitFor(() => {
      expect(notify).toBeTypeOf('function');
    });
    candidate.state = 'closed';
    notify?.('closed');
    refreshed.resolve(undefined);
    const generation = await preparing;

    expect(generation.connections).toEqual([]);
    expect(onDisconnection).toHaveBeenCalledWith(candidate, generation.id);
    await generation.close();
  });

  it('suppresses late connections and retries after a generation closes', async () => {
    vi.useFakeTimers();
    const late = deferred<McpConnectionPort>();
    const lateConnection = connection('late');
    const onConnection = vi.fn();
    const connect = vi.fn(() => late.promise);
    const supervisor = new McpSupervisor({ connect });
    const preparing = supervisor.prepare([server('late')], { onConnection });
    await vi.advanceTimersByTimeAsync(10_000);
    const generation = await preparing;
    await generation.close();
    late.resolve(lateConnection);
    await vi.runAllTimersAsync();

    expect(onConnection).not.toHaveBeenCalled();
    expect(lateConnection.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('surfaces protocol deprecation warnings for logging', async () => {
    const base = connection('legacy-features');
    if (base.discovery === undefined) throw new Error('missing discovery fixture');
    const active: McpConnectionPort = {
      ...base,
      discovery: {
        ...base.discovery,
        capabilities: { tools: {}, logging: {} },
      },
    };
    const generation = await new McpSupervisor({
      connect: () => Promise.resolve(active),
    }).prepare([server('legacy-features')]);

    expect(generation.status()[0]?.deprecationWarnings).toEqual([
      'MCP logging is deprecated in protocol revision 2026-07-28',
    ]);
    await generation.close();
  });
});
