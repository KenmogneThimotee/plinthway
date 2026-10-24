import { expect, test } from '@playwright/test';

import { McpAppHost, type McpAppDescriptor } from '../../packages/mcp-app-host/src/index.js';

const descriptor: McpAppDescriptor = {
  serverId: 'browser',
  toolName: 'panel',
  qualifiedName: 'browser.panel',
  resourceUri: 'ui://browser/panel',
  visibility: ['app'],
};

test('isolates navigation, CSP, tokens, bridge origin, and shutdown', async ({ page, request }) => {
  const html = `<!doctype html><html><body data-ready="no"><script>
    let parentAccess = 'visible';
    try { parentAccess = parent.location.hash || 'empty'; } catch { parentAccess = 'blocked'; }
    document.body.dataset.parentAccess = parentAccess;
    addEventListener('message', event => {
      if (event.data?.result?.protocolVersion) {
        document.body.dataset.ready = 'yes';
        document.body.dataset.protocol = event.data.result.protocolVersion;
        parent.postMessage({ jsonrpc: '2.0', id: 4, method: 'ping', params: { padding: 'x'.repeat(1000) } }, '*');
      }
      if (event.data?.id === 4 && event.data?.error) document.body.dataset.bridgeError = event.data.error.code;
    });
    parent.postMessage({
      jsonrpc: '2.0', id: 1, method: 'ui/initialize',
      params: {
        appInfo: { name: 'security-test', version: '1.0.0' },
        appCapabilities: {}, protocolVersion: '2026-01-26'
      }
    }, '*');
    try { top.location.href = 'https://evil.invalid/escape'; } catch {}
  </script></body></html>`;
  const host = new McpAppHost({
    readResource: () =>
      Promise.resolve({
        contents: [
          {
            uri: descriptor.resourceUri,
            mimeType: 'text/html;profile=mcp-app',
            text: html,
            _meta: { ui: { csp: {}, permissions: {} } },
          },
        ],
      }),
    callTool: () => Promise.resolve({ content: [] }),
    listTools: () => [descriptor],
    maxBridgeBytes: 512,
  });
  const session = await host.open(descriptor, { auditSessionId: 'browser-security-test' });
  try {
    const navigation = await page.goto(session.url);
    expect(navigation?.headers()['content-security-policy']).toContain("default-src 'none'");
    await expect.poll(() => page.url()).toBe(`${session.origin}/`);

    await expect
      .poll(() => page.frames().find((frame) => frame.url().endsWith('/app')))
      .not.toBeUndefined();
    const frame = page.frames().find((candidate) => candidate.url().endsWith('/app'));
    expect(frame).toBeDefined();
    await expect.poll(() => frame?.locator('body').getAttribute('data-ready')).toBe('yes');
    await expect
      .poll(() => frame?.locator('body').getAttribute('data-bridge-error'))
      .toBe('-32000');
    expect(await frame?.locator('body').getAttribute('data-parent-access')).toBe('blocked');
    expect(page.url()).toBe(`${session.origin}/`);
    expect(page.frames().some((candidate) => candidate.url().includes(session.token))).toBe(false);

    const stolen = await request.post(`${session.proxyOrigin}/bridge`, {
      headers: {
        Authorization: 'Bearer stolen',
        Origin: session.proxyOrigin,
        'Content-Type': 'application/json',
      },
      data: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    expect(stolen.status()).toBe(401);
    const spoofed = await request.post(`${session.proxyOrigin}/bridge`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Origin: 'https://evil.invalid',
        'Content-Type': 'application/json',
      },
      data: { jsonrpc: '2.0', id: 3, method: 'ping' },
    });
    expect(spoofed.status()).toBe(403);

    await host.close();
    await expect(request.get(session.origin)).rejects.toThrow();
  } finally {
    await host.close();
  }
});
