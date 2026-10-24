import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@plinthway/shared';

import { McpManager, connectMcpServer } from '../../packages/mcp-client/src/index.js';
import { startHttpMcpServer } from '../mocks/mcp/http-server.js';

const managers: McpManager[] = [];
const closeServers: Array<() => Promise<void>> = [];

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.disconnect()));
  await Promise.allSettled(closeServers.splice(0).map((close) => close()));
});

function manager(): McpManager {
  const value = new McpManager({ connect: connectMcpServer });
  managers.push(value);
  return value;
}

describe('MCP transports', () => {
  it('handshakes, discovers, validates, invokes, and disconnects over stdio', async () => {
    const instance = manager();
    const fixture = fileURLToPath(new URL('../mocks/mcp/stdio-server.ts', import.meta.url));
    await instance.prepare([
      {
        id: 'local',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: [],
      },
    ]);
    await instance.commit();

    expect(instance.listTools().map((tool) => tool.name)).toEqual([
      'local.echo',
      'local.pid',
      'local.wait',
    ]);
    await expect(
      instance.invoke('local.echo', { text: 'hello' }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ trusted: false, content: [{ type: 'text' }] });
    await expect(
      instance.invoke('local.echo', { text: 12 }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
    await expect(instance.invoke('local.wait', {}, { timeoutMs: 25 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const pidResult = await instance.invoke('local.pid', {}, { timeoutMs: 1_000 });
    const pidBlock = Array.isArray(pidResult.content)
      ? (pidResult.content as readonly JsonValue[])[0]
      : undefined;
    if (!isJsonObject(pidBlock) || typeof pidBlock.text !== 'string') {
      throw new Error('stdio fixture returned an invalid PID');
    }
    const childPid = Number(pidBlock.text);
    await instance.disconnect();
    expect(instance.status()).toEqual([]);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('handshakes and invokes over loopback Streamable HTTP', async () => {
    const fixture = await startHttpMcpServer();
    closeServers.push(fixture.close);
    const instance = manager();
    await instance.prepare([{ id: 'remote', transport: 'streamable-http', url: fixture.url }]);
    await instance.commit();

    expect(instance.listTools().map((tool) => tool.name)).toEqual(['remote.echo']);
    await expect(
      instance.invoke('remote.echo', { text: 'hello' }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ trusted: false, serverId: 'remote' });
  });

  it('propagates abort and leaves the connection usable', async () => {
    const instance = manager();
    const fixture = fileURLToPath(new URL('../mocks/mcp/stdio-server.ts', import.meta.url));
    await instance.prepare([
      {
        id: 'local',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: [],
      },
    ]);
    await instance.commit();
    const controller = new AbortController();
    const pending = instance.invoke(
      'local.wait',
      {},
      { timeoutMs: 1_000, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      instance.invoke('local.echo', { text: 'still alive' }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ trusted: false });
  });
});
