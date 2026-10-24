import { describe, expect, it, vi } from 'vitest';

import { McpAppHost } from './host.js';

const descriptor = {
  serverId: 'alpha',
  toolName: 'weather',
  qualifiedName: 'alpha.weather',
  resourceUri: 'ui://alpha/weather',
  visibility: ['model', 'app'] as const,
};

function resource(text = '<!doctype html><button id="run">Run</button>') {
  return {
    contents: [
      {
        uri: descriptor.resourceUri,
        mimeType: 'text/html;profile=mcp-app',
        text,
        _meta: {
          ui: {
            csp: {
              connectDomains: ['https://api.example', 'wss://events.example'],
              resourceDomains: ['https://*.cdn.example'],
            },
          },
        },
      },
    ],
    meta: { serverExtension: { revision: 2 } },
  };
}

describe('McpAppHost', () => {
  it('creates isolated per-session origins and fragment-only tokens', async () => {
    const host = new McpAppHost({
      readResource: vi.fn(() => Promise.resolve(resource())),
      callTool: vi.fn(),
      listTools: vi.fn(() => [descriptor]),
      authorizeOrigin: () => Promise.resolve(true),
    });
    const first = await host.open(descriptor, { auditSessionId: 'session-1' });
    const second = await host.open(descriptor, { auditSessionId: 'session-2' });
    try {
      expect(first.origin).not.toBe(second.origin);
      expect(first.url).toBe(`${first.origin}/#${first.token}`);
      expect(second.token).not.toBe(first.token);

      const page = await fetch(first.origin);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await page.text()).toContain('sandbox="allow-scripts allow-same-origin"');

      expect((await fetch(`${first.origin}/resource`)).status).toBe(401);
      const authorized = await fetch(`${first.origin}/resource`, {
        headers: { Authorization: `Bearer ${first.token}` },
      });
      expect(authorized.status).toBe(200);
      const body = await authorized.text();
      expect(body).toContain('text/html;profile=mcp-app');
      expect(body).toContain('wss://events.example');
      expect(body).toContain('https://*.cdn.example');
    } finally {
      await host.close();
    }
  });

  it('enforces bridge origin, method, payload, visibility, and provenance', async () => {
    const callTool = vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'sunny' }] }));
    const host = new McpAppHost({
      readResource: vi.fn(() => Promise.resolve(resource())),
      callTool,
      listTools: vi.fn(() => [
        descriptor,
        {
          ...descriptor,
          toolName: 'model-only',
          qualifiedName: 'alpha.model-only',
          visibility: ['model'] as const,
        },
      ]),
      listResources: vi.fn(() => [{ uri: 'data://alpha/current', name: 'Current' }]),
      listToolDefinitions: vi.fn(() => [{ name: 'weather', inputSchema: { type: 'object' } }]),
      authorizeOrigin: () => Promise.resolve(true),
      maxBridgeBytes: 256,
    });
    const session = await host.open(descriptor, { auditSessionId: 'session-1' });
    const endpoint = `${session.proxyOrigin}/bridge`;
    const request = (body: unknown, origin = session.proxyOrigin) =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    try {
      expect(
        (await request({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' })).status,
      ).toBe(405);
      expect(
        (await request({ jsonrpc: '2.0', id: 2, method: 'ping' }, 'https://evil.test')).status,
      ).toBe(403);
      expect(
        (
          await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.token}`,
              Origin: session.proxyOrigin,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ padding: 'x'.repeat(300) }),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await request({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'model-only', arguments: {} },
          })
        ).status,
      ).toBe(403);

      const response = await request({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'weather', arguments: { city: 'Paris' } },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { result: { _meta: unknown } };
      expect(payload.result._meta).toEqual({
        plinthway: { trusted: false, serverId: 'alpha', toolName: 'weather', source: 'mcp-app' },
      });
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          appSessionId: session.id,
          auditSessionId: 'session-1',
          callId: '4',
          serverId: 'alpha',
          toolName: 'weather',
          arguments: { city: 'Paris' },
        }),
      );
      const tools = await request({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
      expect(await tools.json()).toMatchObject({
        id: 5,
        result: { tools: [{ name: 'weather', inputSchema: { type: 'object' } }] },
      });
      const listed = await request({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
      expect(await listed.json()).toMatchObject({
        id: 6,
        result: { resources: [{ uri: 'data://alpha/current', name: 'Current' }] },
      });
      const read = await request({
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/read',
        params: { uri: 'data://alpha/current' },
      });
      await expect(read.json()).resolves.toMatchObject({
        id: 7,
        result: {
          _meta: {
            serverExtension: { revision: 2 },
            plinthway: {
              trusted: false,
              serverId: 'alpha',
              uri: 'data://alpha/current',
              source: 'mcp-app',
            },
          },
        },
      });
    } finally {
      await host.close();
    }
  });

  it('caps UI resources and invalidates the token on close', async () => {
    const host = new McpAppHost({
      readResource: vi.fn(() => Promise.resolve(resource('x'.repeat(64)))),
      callTool: vi.fn(),
      listTools: vi.fn(() => [descriptor]),
      maxResourceBytes: 32,
      authorizeOrigin: () => Promise.resolve(true),
    });
    await expect(host.open(descriptor, { auditSessionId: 'session-1' })).rejects.toThrow(
      /exceeds/i,
    );

    const normal = new McpAppHost({
      readResource: vi.fn(() => Promise.resolve(resource())),
      callTool: vi.fn(),
      listTools: vi.fn(() => [descriptor]),
      authorizeOrigin: () => Promise.resolve(true),
    });
    const session = await normal.open(descriptor, { auditSessionId: 'session-1' });
    await session.close();
    await expect(fetch(session.origin)).rejects.toThrow();
    expect(session.closed).toBe(true);
  });

  it('uses listing-level CSP and permissions when content metadata is absent', async () => {
    const host = new McpAppHost({
      readResource: vi.fn(() =>
        Promise.resolve({
          contents: [
            {
              uri: descriptor.resourceUri,
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><p>Listed metadata</p>',
            },
          ],
        }),
      ),
      callTool: vi.fn(),
      listTools: vi.fn(() => [descriptor]),
      listResources: vi.fn(() => [
        {
          uri: descriptor.resourceUri,
          _meta: {
            ui: {
              csp: { connectDomains: ['https://api.example'] },
              permissions: { geolocation: {} },
            },
          },
        },
      ]),
      authorizeOrigin: () => Promise.resolve(true),
    });
    const session = await host.open(descriptor, { auditSessionId: 'session-1' });
    try {
      const response = await fetch(`${session.proxyOrigin}/resource`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const payload = (await response.json()) as {
        readonly csp: { readonly connectDomains: readonly string[] };
        readonly permissions: { readonly geolocation: unknown };
      };
      expect(payload.csp.connectDomains).toEqual(['https://api.example']);
      expect(payload.permissions.geolocation).toEqual({});
    } finally {
      await host.close();
    }
  });

  it('honors the App teardown notification', async () => {
    const host = new McpAppHost({
      readResource: vi.fn(() => Promise.resolve(resource())),
      callTool: vi.fn(),
      listTools: vi.fn(() => [descriptor]),
      authorizeOrigin: () => Promise.resolve(true),
    });
    const session = await host.open(descriptor, { auditSessionId: 'session-1' });
    const response = await fetch(`${session.proxyOrigin}/bridge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        Origin: session.proxyOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'ui/notifications/request-teardown',
        params: {},
      }),
    });
    expect(response.status).toBe(204);
    await vi.waitFor(() => {
      expect(session.closed).toBe(true);
    });
  });
});
