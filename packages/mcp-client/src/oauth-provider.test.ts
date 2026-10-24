import { describe, expect, it, vi } from 'vitest';

import type { Credential, CredentialStore } from '@plinthway/auth';
import {
  exchangeAuthorization,
  exchangeJwtAuthGrant,
  InsecureTokenEndpointError,
  requestJwtAuthorizationGrant,
} from '@modelcontextprotocol/client';

import { createRestrictedFetch } from './network-policy.js';
import { PlinthwayOAuthClientProvider, McpOAuthController } from './oauth-provider.js';

class MemoryCredentialStore implements CredentialStore {
  readonly source = 'keyring' as const;
  readonly values = new Map<string, Credential>();

  get(key: string): Promise<Credential | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, credential: Credential): Promise<void> {
    this.values.set(key, credential);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

function provider(store = new MemoryCredentialStore()) {
  return new PlinthwayOAuthClientProvider({
    serverId: 'docs',
    serverUrl: 'https://mcp.example.com/rpc',
    redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
    scopes: ['tools.read'],
    store,
    redirectToAuthorization: vi.fn(),
  });
}

describe('PlinthwayOAuthClientProvider', () => {
  it('defers browser redirection until a managed callback listener is ready', async () => {
    const opened = vi.fn();
    const options = {
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1/oauth/callback',
      scopes: [],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: opened,
      deferAuthorizationRedirect: true,
    };
    const oauth = new PlinthwayOAuthClientProvider(options);

    await oauth.redirectToAuthorization(
      new URL('https://issuer.example.com/authorize?redirect_uri=http://127.0.0.1/oauth/callback'),
    );

    expect(opened).not.toHaveBeenCalled();
  });

  it('binds rotated tokens to issuer and resource without cross-issuer reuse', async () => {
    const store = new MemoryCredentialStore();
    const oauth = provider(store);
    await oauth.saveTokens(
      {
        access_token: 'first-access',
        refresh_token: 'first-refresh',
        token_type: 'Bearer',
        expires_in: 60,
        issuer: 'https://issuer-a.example.com',
      },
      { issuer: 'https://issuer-a.example.com' },
    );
    await oauth.saveTokens(
      {
        access_token: 'second-access',
        refresh_token: 'second-refresh',
        token_type: 'Bearer',
        expires_in: 120,
        issuer: 'https://issuer-a.example.com',
      },
      { issuer: 'https://issuer-a.example.com' },
    );

    await expect(oauth.tokens({ issuer: 'https://issuer-a.example.com' })).resolves.toMatchObject({
      access_token: 'second-access',
      refresh_token: 'second-refresh',
      issuer: 'https://issuer-a.example.com',
    });
    await expect(oauth.tokens({ issuer: 'https://issuer-b.example.com' })).resolves.toBeUndefined();
    await expect(oauth.tokens()).resolves.toMatchObject({ access_token: 'second-access' });
    expect(JSON.stringify([...store.values.values()])).not.toContain('mcp.example.com/rpc"');
  });

  it('prefers client metadata URL, then a pre-registered ID, then issuer-bound registration', async () => {
    const store = new MemoryCredentialStore();
    const metadata = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientMetadataUrl: 'https://client.example.com/oauth.json',
      scopes: [],
      store,
      redirectToAuthorization: vi.fn(),
    });
    await expect(
      metadata.clientInformation({ issuer: 'https://issuer.example.com' }),
    ).resolves.toMatchObject({
      client_id: 'https://client.example.com/oauth.json',
      issuer: 'https://issuer.example.com',
    });

    const registered = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      clientSecret: 'pre-registered-secret',
      scopes: [],
      store,
      redirectToAuthorization: vi.fn(),
    });
    await expect(
      registered.clientInformation({ issuer: 'https://issuer.example.com' }),
    ).resolves.toMatchObject({
      client_id: 'pre-registered',
      client_secret: 'pre-registered-secret',
      issuer: 'https://issuer.example.com',
    });

    const dynamic = provider(store);
    await dynamic.saveClientInformation(
      { client_id: 'dynamic', client_secret: 'secret', issuer: 'https://issuer.example.com' },
      { issuer: 'https://issuer.example.com' },
    );
    await expect(
      dynamic.clientInformation({ issuer: 'https://issuer.example.com' }),
    ).resolves.toMatchObject({ client_id: 'dynamic', issuer: 'https://issuer.example.com' });
    await expect(
      dynamic.clientInformation({ issuer: 'https://other.example.com' }),
    ).resolves.toBeUndefined();
  });

  it('persists PKCE and discovery state while validating the resource origin', async () => {
    const oauth = provider();
    await oauth.saveCodeVerifier('verifier');
    await expect(oauth.codeVerifier()).resolves.toBe('verifier');
    await oauth.saveDiscoveryState({
      authorizationServerUrl: 'https://issuer.example.com',
      authorizationServerMetadata: {
        issuer: 'https://issuer.example.com',
        authorization_endpoint: 'https://issuer.example.com/authorize',
        token_endpoint: 'https://issuer.example.com/token',
        response_types_supported: ['code'],
      },
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    });
    await expect(oauth.discoveryState()).resolves.toMatchObject({
      authorizationServerUrl: 'https://issuer.example.com',
    });
    await expect(
      oauth.validateResourceURL('https://mcp.example.com/rpc', 'https://mcp.example.com/rpc'),
    ).resolves.toEqual(new URL('https://mcp.example.com/rpc'));
    await expect(
      oauth.validateResourceURL('https://mcp.example.com/rpc', 'https://mcp.example.com'),
    ).resolves.toMatchObject({ href: 'https://mcp.example.com' });
    await expect(
      oauth.validateResourceURL('https://mcp.example.com/rpc', 'https://evil.example/rpc'),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

describe('McpOAuthController', () => {
  it('closes the loopback listener when opening the authorization URL fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const startLoopback = vi.fn().mockResolvedValue({
      redirectUrl: new URL('http://127.0.0.1:45678/oauth/callback'),
      result: new Promise(() => undefined),
      close,
    });
    const fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'pre-registered',
      scopes: ['tools.read'],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn().mockRejectedValue(new Error('browser failed')),
      deferAuthorizationRedirect: true,
    });
    const controller = new McpOAuthController({ startLoopback });
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, ['tools.read'], fetch, {
      automaticLoopback: true,
    });

    await expect(controller.authorize('docs')).rejects.toThrow('browser failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the loopback listener when client invalidation fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const startLoopback = vi.fn().mockResolvedValue({
      redirectUrl: new URL('http://127.0.0.1:45678/oauth/callback'),
      result: new Promise(() => undefined),
      close,
    });
    const oauth = provider();
    vi.spyOn(oauth, 'invalidateCredentials').mockRejectedValueOnce(new Error('keyring failed'));
    const controller = new McpOAuthController({ startLoopback });
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, [], undefined, {
      automaticLoopback: true,
    });

    await expect(controller.authorize('docs')).rejects.toThrow('keyring failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('completes standard OAuth through a random loopback callback', async () => {
    let complete!: (value: {
      readonly code: string;
      readonly state: string;
      readonly issuer?: string;
    }) => void;
    const callbackResult = new Promise<{
      readonly code: string;
      readonly state: string;
      readonly issuer?: string;
    }>((resolve) => {
      complete = resolve;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const startLoopback = vi.fn(({ expectedState }: { readonly expectedState: string }) => {
      return Promise.resolve({
        redirectUrl: new URL('http://127.0.0.1:45678/oauth/callback'),
        result: callbackResult,
        close,
        expectedState,
      });
    });
    const opened = vi.fn();
    const providerOptions = {
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'pre-registered',
      scopes: ['tools.read'],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: opened,
      deferAuthorizationRedirect: true,
    };
    const oauth = new PlinthwayOAuthClientProvider(providerOptions);
    const invalidateCredentials = vi.spyOn(oauth, 'invalidateCredentials');
    const fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      }
      if (url.pathname === '/token') {
        return Promise.resolve(
          Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 300 }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const controller = new McpOAuthController({ startLoopback });
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, ['tools.read'], fetch, {
      automaticLoopback: true,
    });

    const started = await controller.authorize('docs');
    const authorizationUrl = new URL(started.authorizationUrl ?? 'missing:');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:45678/oauth/callback',
    );
    expect(startLoopback).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith(authorizationUrl);
    expect(invalidateCredentials).toHaveBeenCalledWith('client');
    const state = authorizationUrl.searchParams.get('state');
    if (state === null) throw new Error('missing state');
    complete({ code: 'callback-code', state, issuer: 'https://issuer.example.com' });
    await expect(started.waitForCompletion?.()).resolves.toBeUndefined();
    await expect(oauth.tokens()).resolves.toMatchObject({ access_token: 'access' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('replaces stale enterprise handlers when a server switches back to standard OAuth', async () => {
    const staleHandler = vi.fn().mockResolvedValue({ state: 'authorized' as const });
    const oauth = provider();
    const controller = new McpOAuthController();
    controller.registerHandler('docs', staleHandler);
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, []);

    await expect(
      controller.authorize('docs', { code: 'callback', state: 'wrong-state' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(staleHandler).not.toHaveBeenCalled();
  });

  it('falls back to OIDC discovery when OAuth authorization-server metadata is unavailable', async () => {
    const fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      if (url.pathname.includes('openid-configuration')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            jwks_uri: 'https://issuer.example.com/jwks',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      scopes: ['tools.read'],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    const controller = new McpOAuthController();
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, ['tools.read'], fetch);

    const started = await controller.authorize('docs');
    expect(started.state).toBe('redirect');
    expect(started.authorizationUrl).toContain('https://issuer.example.com/authorize');
    expect(
      fetch.mock.calls.some(([input]) =>
        new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        ).pathname.includes('openid-configuration'),
      ),
    ).toBe(true);
  });

  it('requests the union of granted and newly required scopes for step-up authorization', async () => {
    const fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      scopes: ['tools.read'],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    await oauth.saveTokens(
      {
        access_token: 'old-access',
        token_type: 'Bearer',
        scope: 'tools.read',
        issuer: 'https://issuer.example.com',
      },
      { issuer: 'https://issuer.example.com' },
    );
    await oauth.saveDiscoveryState({
      authorizationServerUrl: 'https://old-issuer.example.com',
      authorizationServerMetadata: {
        issuer: 'https://old-issuer.example.com',
        authorization_endpoint: 'https://old-issuer.example.com/authorize',
        token_endpoint: 'https://old-issuer.example.com/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/rpc',
    });
    const controller = new McpOAuthController();
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, ['tools.read'], fetch);

    const started = await controller.authorize('docs', { requiredScope: 'resources.read' });
    const authorizationUrl = new URL(started.authorizationUrl ?? 'missing:');
    expect(started.state).toBe('redirect');
    expect(authorizationUrl.origin).toBe('https://issuer.example.com');
    expect(new Set(authorizationUrl.searchParams.get('scope')?.split(' '))).toEqual(
      new Set(['tools.read', 'resources.read']),
    );
  });

  it('discovers metadata, requires PKCE S256, validates state/issuer, and exchanges the code', async () => {
    const tokenBodies: string[] = [];
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
            scopes_supported: ['tools.read'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            registration_endpoint: 'https://issuer.example.com/register',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
          }),
        );
      }
      if (url.pathname === '/register') {
        return Promise.resolve(
          Response.json(
            {
              client_id: 'dynamic-client',
              redirect_uris: ['http://127.0.0.1:32123/oauth/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            },
            { status: 201 },
          ),
        );
      }
      if (url.pathname === '/token') {
        const body = init?.body;
        tokenBodies.push(
          typeof body === 'string' || body instanceof URLSearchParams ? body.toString() : '',
        );
        return Promise.resolve(
          Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            token_type: 'Bearer',
            expires_in: 300,
            scope: 'tools.read',
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const store = new MemoryCredentialStore();
    const oauth = provider(store);
    const controller = new McpOAuthController();
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, ['tools.read'], fetch);

    const started = await controller.authorize('docs');
    expect(started).toMatchObject({ state: 'redirect' });
    const authorizationUrl = new URL(started.authorizationUrl ?? 'missing:');
    expect(authorizationUrl.origin).toBe('https://issuer.example.com');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://mcp.example.com/rpc');
    const state = authorizationUrl.searchParams.get('state');
    if (state === null) throw new Error('missing OAuth state');

    await expect(
      controller.authorize('docs', {
        code: 'callback-code',
        state: 'wrong-state',
        issuer: 'https://issuer.example.com',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(
      controller.authorize('docs', {
        code: 'callback-code',
        state,
        issuer: 'https://attacker.example.com',
      }),
    ).rejects.toThrow();

    await expect(
      controller.authorize('docs', {
        code: 'callback-code',
        state,
        issuer: 'https://issuer.example.com',
      }),
    ).resolves.toEqual({ state: 'authorized' });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]).toContain('code=callback-code');
    expect(tokenBodies[0]).toContain('code_verifier=');
    expect(tokenBodies[0]).toContain('resource=https%3A%2F%2Fmcp.example.com%2Frpc');
    await expect(oauth.tokens()).resolves.toMatchObject({
      access_token: 'access',
      refresh_token: 'refresh',
      issuer: 'https://issuer.example.com',
    });
  });

  it('exchanges an authorization code through a restricted HTTP loopback alias', async () => {
    const requests: Array<{
      readonly path: string;
      readonly method: string;
      readonly body: string;
    }> = [];
    const serverUrl = 'http://api.local.test/mcp';
    const baseFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push({
          path: url.pathname,
          method: request.method,
          body: request.method === 'POST' ? await request.clone().text() : '',
        });
        if (url.pathname.includes('oauth-protected-resource')) {
          return Response.json({ resource: serverUrl, authorization_servers: [url.origin] });
        }
        if (url.pathname.includes('oauth-authorization-server')) {
          return Response.json({
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/oauth/authorize`,
            token_endpoint: `${url.origin}/oauth/token`,
            registration_endpoint: `${url.origin}/oauth/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
          });
        }
        if (url.pathname === '/oauth/register') {
          return Response.json(
            {
              client_id: 'dynamic-loopback-client',
              redirect_uris: ['http://127.0.0.1:32123/oauth/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            },
            { status: 201 },
          );
        }
        if (url.pathname === '/oauth/token') {
          return Response.json({
            access_token: 'loopback-access',
            refresh_token: 'loopback-refresh',
            token_type: 'Bearer',
            expires_in: 300,
          });
        }
        return new Response('not found', { status: 404 });
      },
    );
    const restrictedFetch = createRestrictedFetch({
      originalUrl: new URL(serverUrl),
      allowedOrigins: [],
      lookup: () => Promise.resolve(['127.0.0.1']),
      fetch: baseFetch,
      isCredentialDestination: (url) => url.pathname === '/oauth/token',
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'api-local-test-mcp',
      serverUrl,
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      scopes: [],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    const controller = new McpOAuthController();
    controller.register('api-local-test-mcp', serverUrl, oauth, [], restrictedFetch);

    const started = await controller.authorize('api-local-test-mcp');
    const authorizationUrl = new URL(started.authorizationUrl ?? 'missing:');
    const state = authorizationUrl.searchParams.get('state');
    if (state === null) throw new Error('missing OAuth state');
    await expect(
      controller.authorize('api-local-test-mcp', {
        code: 'loopback-code',
        state,
        issuer: 'http://api.local.test',
      }),
    ).resolves.toEqual({ state: 'authorized' });

    expect(requests.map(({ path, method }) => `${method} ${path}`)).toEqual([
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server',
      'POST /oauth/register',
      'POST /oauth/token',
    ]);
    expect(requests.at(-1)?.body).toContain('code=loopback-code');
    await expect(oauth.tokens()).resolves.toMatchObject({
      access_token: 'loopback-access',
      refresh_token: 'loopback-refresh',
      issuer: 'http://api.local.test',
    });
  });

  it('keeps ordinary SDK fetches from sending credentials to HTTP aliases', async () => {
    const plainFetch = vi.fn(() =>
      Promise.resolve(Response.json({ access_token: 'unsafe', token_type: 'Bearer' })),
    );

    await expect(
      exchangeAuthorization('http://api.local.test', {
        metadata: {
          issuer: 'http://api.local.test',
          authorization_endpoint: 'http://api.local.test/oauth/authorize',
          token_endpoint: 'http://api.local.test/oauth/token',
          response_types_supported: ['code'],
        },
        clientInformation: { client_id: 'plain-client' },
        authorizationCode: 'authorization-code',
        codeVerifier: 'code-verifier',
        redirectUri: 'http://127.0.0.1:32123/oauth/callback',
        fetchFn: plainFetch,
      }),
    ).rejects.toBeInstanceOf(InsecureTokenEndpointError);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it('normalizes SDK token endpoint failures without exposing the authorization code', async () => {
    const serverUrl = 'http://api.local.test/mcp';
    const plainFetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.includes('oauth-protected-resource')) {
          return Promise.resolve(
            Response.json({ resource: serverUrl, authorization_servers: [url.origin] }),
          );
        }
        if (url.pathname.includes('oauth-authorization-server')) {
          return Promise.resolve(
            Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/oauth/authorize`,
              token_endpoint: `${url.origin}/oauth/token`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              code_challenge_methods_supported: ['S256'],
            }),
          );
        }
        return Promise.resolve(Response.json({ access_token: 'unsafe', token_type: 'Bearer' }));
      },
    );
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'api-local-test-mcp',
      serverUrl,
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      scopes: [],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    const controller = new McpOAuthController();
    controller.register('api-local-test-mcp', serverUrl, oauth, [], plainFetch);
    const started = await controller.authorize('api-local-test-mcp');
    const state = new URL(started.authorizationUrl ?? 'missing:').searchParams.get('state');
    if (state === null) throw new Error('missing OAuth state');

    const failure = await controller
      .authorize('api-local-test-mcp', {
        code: 'do-not-leak-authorization-code',
        state,
        issuer: 'http://api.local.test',
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'AUTH_FAILED',
      details: {
        serverId: 'api-local-test-mcp',
        reason: 'insecure_token_endpoint',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('do-not-leak-authorization-code');
    expect(plainFetch).toHaveBeenCalledTimes(2);
  });

  it('redacts hostile OAuth error codes and SDK retry warnings', async () => {
    const serverUrl = 'https://mcp.example.com/rpc';
    let tokenAttempts = 0;
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({ resource: serverUrl, authorization_servers: [url.origin] }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/oauth/authorize`,
            token_endpoint: `${url.origin}/oauth/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
      }
      tokenAttempts += 1;
      return Promise.resolve(
        Response.json(
          tokenAttempts === 1
            ? {
                error: 'invalid_grant',
                error_description: 'echo do-not-leak-verifier',
              }
            : {
                error: 'do-not-leak-authorization-code',
                error_description: 'echo do-not-leak-authorization-code',
              },
          { status: 400 },
        ),
      );
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl,
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      scopes: [],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    const controller = new McpOAuthController();
    controller.register('docs', serverUrl, oauth, [], fetch);
    const started = await controller.authorize('docs');
    const state = new URL(started.authorizationUrl ?? 'missing:').searchParams.get('state');
    if (state === null) throw new Error('missing OAuth state');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failure = await controller
        .authorize('docs', {
          code: 'do-not-leak-authorization-code',
          state,
          issuer: 'https://mcp.example.com',
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'AUTH_FAILED',
        details: { serverId: 'docs', reason: 'oauth_error', oauthCode: 'unknown_oauth_error' },
      });
      expect(JSON.stringify(failure)).not.toMatch(/do-not-leak-(authorization-code|verifier)/u);
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /do-not-leak-(authorization-code|verifier)/u,
      );
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('uses restricted fetches for both enterprise HTTP loopback token exchanges', async () => {
    const grantTypeBodies: string[] = [];
    const restrictedFetch = createRestrictedFetch({
      originalUrl: new URL('http://api.local.test/mcp'),
      allowedOrigins: [],
      lookup: () => Promise.resolve(['127.0.0.1']),
      fetch: async (input, init) => {
        const body = await new Request(input, init).text();
        grantTypeBodies.push(body);
        if (body.includes('requested_token_type=')) {
          return Response.json({
            access_token: 'jwt-authorization-grant',
            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
            token_type: 'N_A',
            expires_in: 60,
          });
        }
        return Response.json({ access_token: 'mcp-access-token', token_type: 'Bearer' });
      },
    });

    await expect(
      requestJwtAuthorizationGrant({
        tokenEndpoint: 'http://api.local.test/identity/token',
        audience: 'http://api.local.test',
        resource: 'http://api.local.test/mcp',
        idToken: 'identity-token',
        clientId: 'identity-client',
        fetchFn: restrictedFetch,
      }),
    ).resolves.toMatchObject({ jwtAuthGrant: 'jwt-authorization-grant' });
    await expect(
      exchangeJwtAuthGrant({
        tokenEndpoint: 'http://api.local.test/oauth/token',
        jwtAuthGrant: 'jwt-authorization-grant',
        clientId: 'mcp-client',
        clientSecret: 'mcp-secret',
        fetchFn: restrictedFetch,
      }),
    ).resolves.toMatchObject({ access_token: 'mcp-access-token' });
    expect(grantTypeBodies).toHaveLength(2);
  });

  it('rejects authorization servers that do not support PKCE S256', async () => {
    const fetch = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Promise.resolve(
          Response.json({
            resource: 'https://mcp.example.com/rpc',
            authorization_servers: ['https://issuer.example.com'],
          }),
        );
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Promise.resolve(
          Response.json({
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://issuer.example.com/authorize',
            token_endpoint: 'https://issuer.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['plain'],
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const oauth = new PlinthwayOAuthClientProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/rpc',
      redirectUrl: 'http://127.0.0.1:32123/oauth/callback',
      clientId: 'pre-registered',
      scopes: [],
      store: new MemoryCredentialStore(),
      redirectToAuthorization: vi.fn(),
    });
    const controller = new McpOAuthController();
    controller.register('docs', 'https://mcp.example.com/rpc', oauth, [], fetch);

    await expect(controller.authorize('docs')).rejects.toThrow(/S256|PKCE/i);
  });
});
