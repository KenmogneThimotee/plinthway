import { describe, expect, it, vi } from 'vitest';

import type { PlinthwayError } from '@plinthway/shared';

import {
  assertAllowedMcpUrl,
  assertAllowedPublicMcpUrl,
  createRestrictedFetch,
  type HostLookup,
} from './network-policy.js';

const publicLookup = vi.fn(() => Promise.resolve(['93.184.216.34']));
const privateLookup = vi.fn(() => Promise.resolve(['10.0.0.8']));

describe('MCP network policy', () => {
  it('rejects loopback and private destinations for untrusted App CSP origins', async () => {
    await expect(
      assertAllowedPublicMcpUrl(new URL('http://127.0.0.1:3000'), publicLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    await expect(
      assertAllowedPublicMcpUrl(new URL('https://internal.example'), privateLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    await expect(
      assertAllowedPublicMcpUrl(new URL('https://example.com'), publicLookup),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedPublicMcpUrl(new URL('http://api.local.test'), () =>
        Promise.resolve(['127.0.0.1', '::1']),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  });
  it('requires HTTPS except for loopback and rejects URL credentials', async () => {
    await expect(
      assertAllowedMcpUrl(new URL('https://example.com/mcp'), [], publicLookup),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedMcpUrl(new URL('http://127.0.0.1:3000/mcp'), [], publicLookup),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedMcpUrl(new URL('http://example.com/mcp'), [], publicLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    await expect(
      assertAllowedMcpUrl(new URL('https://user:pass@example.com/mcp'), [], publicLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  });

  it('allows HTTP aliases only when every resolved address is loopback', async () => {
    const url = new URL('http://api.local.test/mcp');
    const loopbackLookup = vi.fn(() => Promise.resolve(['127.0.0.1', '::1']));

    await expect(assertAllowedMcpUrl(url, [], loopbackLookup)).resolves.toBeUndefined();
    await expect(assertAllowedMcpUrl(url, [], privateLookup)).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    await expect(assertAllowedMcpUrl(url, [url.origin], privateLookup)).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    await expect(assertAllowedMcpUrl(url, [], publicLookup)).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    await expect(
      assertAllowedMcpUrl(url, [], () => Promise.resolve(['127.0.0.1', '93.184.216.34'])),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  });

  it('resolves every HTTP hostname instead of trusting loopback-looking names', async () => {
    await expect(
      assertAllowedMcpUrl(new URL('http://127.attacker.example/mcp'), [], publicLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    await expect(
      assertAllowedMcpUrl(new URL('http://localhost/mcp'), [], publicLookup),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    await expect(
      assertAllowedMcpUrl(new URL('http://localhost/mcp'), [], () =>
        Promise.resolve(['127.0.0.1', '::1']),
      ),
    ).resolves.toBeUndefined();
  });

  it('recognizes equivalent IPv4-mapped IPv6 loopback forms', async () => {
    const url = new URL('http://api.local.test/mcp');

    await expect(
      assertAllowedMcpUrl(url, [], () =>
        Promise.resolve(['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']),
      ),
    ).resolves.toBeUndefined();
  });

  it('revalidates an HTTP loopback alias in the socket lookup to block DNS rebinding', async () => {
    const rebindingLookup = vi
      .fn<HostLookup>()
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['93.184.216.34']);
    const url = new URL('http://api.local.test:32123/mcp');
    const restricted = createRestrictedFetch({
      originalUrl: url,
      allowedOrigins: [],
      lookup: rebindingLookup,
    });

    await expect(restricted(url)).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
    expect(rebindingLookup).toHaveBeenCalledTimes(2);
  });

  it('revalidates HTTP loopback aliases across redirects', async () => {
    const lookup = vi
      .fn<HostLookup>()
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['10.0.0.8']);
    const redirectingFetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: 'http://other.local.test/mcp' },
        }),
      ),
    );
    const restricted = createRestrictedFetch({
      originalUrl: new URL('http://api.local.test/mcp'),
      allowedOrigins: [],
      lookup,
      fetch: redirectingFetch,
    });

    await expect(restricted('http://api.local.test/mcp')).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(redirectingFetch).toHaveBeenCalledOnce();
  });

  it('blocks resolved private destinations unless their origin is allowlisted', async () => {
    const url = new URL('https://internal.example/mcp');
    await expect(assertAllowedMcpUrl(url, [], privateLookup)).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    await expect(assertAllowedMcpUrl(url, [url.origin], privateLookup)).resolves.toBeUndefined();
  });

  it('enforces the address policy again in the socket lookup to block DNS rebinding', async () => {
    const rebindingLookup = vi
      .fn<HostLookup>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);
    const restricted = createRestrictedFetch({
      originalUrl: new URL('https://rebind.example/mcp'),
      allowedOrigins: [],
      lookup: rebindingLookup,
    });

    await expect(restricted('https://rebind.example/mcp')).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    expect(rebindingLookup).toHaveBeenCalledTimes(2);
  });

  it('revalidates redirects, limits hops, and never forwards credentials cross-origin', async () => {
    const seen: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
    const responses = [
      new Response(null, { status: 307, headers: { location: 'https://second.example/mcp' } }),
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    const baseFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'),
      });
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected fetch');
      return Promise.resolve(response);
    });
    const restricted = createRestrictedFetch({
      originalUrl: new URL('https://first.example/mcp'),
      allowedOrigins: [],
      lookup: publicLookup,
      fetch: baseFetch,
      credentialHeaderNames: ['x-api-key'],
    });

    await restricted('https://first.example/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'x-api-key': 'secret', 'x-public': 'yes' },
      body: '{}',
    });
    expect(seen).toEqual([
      {
        url: 'https://first.example/mcp',
        authorization: 'Bearer secret',
        apiKey: 'secret',
      },
      { url: 'https://second.example/mcp', authorization: null, apiKey: null },
    ]);

    const redirectingFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: '/again' } })),
    );
    const bounded = createRestrictedFetch({
      originalUrl: new URL('https://example.com/mcp'),
      allowedOrigins: [],
      lookup: publicLookup,
      fetch: redirectingFetch,
    });
    await expect(bounded('https://example.com/mcp')).rejects.toEqual(
      expect.objectContaining<Partial<PlinthwayError>>({ code: 'NETWORK_DENIED' }),
    );
    expect(redirectingFetch).toHaveBeenCalledTimes(4);
  });

  it('forwards OAuth credentials only to an explicitly trusted authorization-server origin', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const restricted = createRestrictedFetch({
      originalUrl: new URL('https://mcp.example/api'),
      allowedOrigins: [],
      credentialOrigins: ['https://auth.example'],
      lookup: publicLookup,
      fetch: (input, init) => {
        const request = new Request(input, init);
        seen.push({ url: request.url, authorization: request.headers.get('authorization') });
        return Promise.resolve(new Response('{}'));
      },
    });

    await restricted('https://auth.example/token', {
      headers: { authorization: 'Basic credential' },
    });
    await restricted('https://other.example/token', {
      headers: { authorization: 'Basic credential' },
    });
    expect(seen).toEqual([
      { url: 'https://auth.example/token', authorization: 'Basic credential' },
      { url: 'https://other.example/token', authorization: null },
    ]);
  });

  it('does not treat a discovered token endpoint as trusted for MCP bearer tokens', async () => {
    const seen: Array<string | null> = [];
    const tokenEndpoint = 'https://tokens.example/oauth/token';
    const restricted = createRestrictedFetch({
      originalUrl: new URL('https://mcp.example/api'),
      allowedOrigins: [],
      isCredentialDestination: (url) => url.href === tokenEndpoint,
      lookup: publicLookup,
      fetch: (input, init) => {
        const request = new Request(input, init);
        seen.push(request.headers.get('authorization'));
        return Promise.resolve(new Response('{}'));
      },
    });

    await restricted(tokenEndpoint, { headers: { authorization: 'Basic client-secret' } });
    await restricted(tokenEndpoint, { headers: { authorization: 'Bearer resource-token' } });
    expect(seen).toEqual(['Basic client-secret', null]);
  });

  it('refuses to replay credential-bearing form bodies across origins', async () => {
    const restricted = createRestrictedFetch({
      originalUrl: new URL('https://auth.example/token'),
      allowedOrigins: [],
      lookup: publicLookup,
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: 'https://other.example/token' },
          }),
        ),
    });
    await expect(
      restricted('https://auth.example/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_secret: 'secret' }),
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_DENIED' });
  });
});
