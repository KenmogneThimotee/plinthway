import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  auth as authorizeOAuth,
  fetchToken,
  InsecureTokenEndpointError,
  refreshAuthorization,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import type { Credential, CredentialStore } from '@plinthway/auth';
import { redact } from '@plinthway/shared';

import {
  createClientCredentialsProvider,
  createEnterpriseAuthorizationProvider,
  enterpriseIdentityCredentialKey,
  storeEnterpriseIdentityAssertion,
  validateJwtClaims,
  validateJwtAuthorizationGrant,
} from './auth-extensions.js';
import { createRestrictedFetch } from './network-policy.js';

class MemoryStore implements CredentialStore {
  readonly source = 'keyring' as const;
  readonly values = new Map<string, Credential>();
  get(key: string): Promise<Credential | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: Credential): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

function jwt(
  payload: Readonly<Record<string, unknown>>,
  header = { alg: 'none', typ: 'JWT' },
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.`;
}

describe('OAuth Client Credentials extension', () => {
  it('preserves restricted-fetch trust through transport wrappers for machine and refresh grants', async () => {
    const serverUrl = 'http://api.local.test/mcp';
    const issuer = 'http://api.local.test';
    const tokenBodies: string[] = [];
    const baseFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      tokenBodies.push(await request.text());
      return Response.json({
        access_token: `access-${String(tokenBodies.length)}`,
        token_type: 'Bearer',
      });
    };
    const restrictedFetch = createRestrictedFetch({
      originalUrl: new URL(serverUrl),
      allowedOrigins: [],
      lookup: () => Promise.resolve(['127.0.0.1']),
      fetch: baseFetch,
      isCredentialDestination: (url) => url.pathname === '/oauth/token',
    });
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: restrictedFetch,
      requestInit: { redirect: 'manual' },
      redirectPolicy: 'follow',
    });
    const wrappedFetch = (
      transport as unknown as { readonly _fetchWithInit: typeof globalThis.fetch }
    )._fetchWithInit;
    const store = new MemoryStore();
    store.values.set('machine-secret', { type: 'api-key', secret: 'machine-secret' });
    const provider = await createClientCredentialsProvider({
      serverId: 'docs',
      serverUrl,
      auth: {
        mode: 'client-credentials',
        clientId: 'plinthway-service',
        issuer,
        authentication: 'client-secret-basic',
        credential: { source: 'keyring', id: 'machine-secret' },
        scopes: ['docs:read'],
        algorithm: 'RS256',
      },
      store,
    });
    const metadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['client_credentials', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    };

    await expect(
      fetchToken(provider, issuer, {
        metadata,
        resource: serverUrl,
        scope: 'docs:read',
        fetchFn: wrappedFetch,
      }),
    ).resolves.toMatchObject({ access_token: 'access-1' });
    await expect(
      refreshAuthorization(issuer, {
        metadata,
        clientInformation: { client_id: 'plinthway-service', client_secret: 'machine-secret' },
        refreshToken: 'refresh-token',
        resource: serverUrl,
        fetchFn: wrappedFetch,
      }),
    ).resolves.toMatchObject({ access_token: 'access-2' });
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[0]).toContain('grant_type=client_credentials');
    expect(tokenBodies[1]).toContain('grant_type=refresh_token');

    const plainFetch = vi.fn(baseFetch);
    const plainTransport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: plainFetch,
      requestInit: { redirect: 'manual' },
      redirectPolicy: 'follow',
    });
    const plainWrappedFetch = (
      plainTransport as unknown as { readonly _fetchWithInit: typeof globalThis.fetch }
    )._fetchWithInit;
    await expect(
      refreshAuthorization(issuer, {
        metadata,
        clientInformation: { client_id: 'plain-client' },
        refreshToken: 'refresh-token',
        fetchFn: plainWrappedFetch,
      }),
    ).rejects.toBeInstanceOf(InsecureTokenEndpointError);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['client-secret-basic', 'client_secret_basic'],
    ['client-secret-post', 'client_secret_post'],
  ] as const)('creates a durable, issuer-bound %s provider', async (authentication, method) => {
    const store = new MemoryStore();
    store.values.set('machine-secret', { type: 'api-key', secret: 'never-print-this' });
    const provider = await createClientCredentialsProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/api',
      auth: {
        mode: 'client-credentials',
        clientId: 'plinthway-service',
        issuer: 'https://auth.example.com',
        authentication,
        credential: { source: 'keyring', id: 'machine-secret' },
        scopes: ['docs:read'],
        algorithm: 'RS256',
      },
      store,
      now: () => 1_000_000,
    });

    expect(provider.clientMetadata.token_endpoint_auth_method).toBe(method);
    expect(provider.clientInformation({ issuer: 'https://auth.example.com' })).toMatchObject({
      client_id: 'plinthway-service',
      issuer: 'https://auth.example.com/',
    });
    expect(() => provider.clientInformation({ issuer: 'https://different.example.com' })).toThrow(
      /issuer/u,
    );
    expect(redact('failure: never-print-this')).toBe('failure: [REDACTED]');
  });

  it('supports private_key_jwt and persists only unexpired, sufficiently scoped tokens', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const store = new MemoryStore();
    store.values.set('machine-key', {
      type: 'api-key',
      secret: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    let now = 1_000_000;
    const provider = await createClientCredentialsProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/api',
      auth: {
        mode: 'client-credentials',
        clientId: 'plinthway-service',
        issuer: 'https://auth.example.com',
        authentication: 'private-key-jwt',
        credential: { source: 'keyring', id: 'machine-key' },
        scopes: ['docs:read'],
        algorithm: 'RS256',
      },
      store,
      now: () => now,
    });

    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('private_key_jwt');
    expect(provider.addClientAuthentication).toBeTypeOf('function');
    await expect(
      provider.saveTokens({ access_token: 'bad-scope', token_type: 'bearer', scope: 'other' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await provider.saveTokens({
      access_token: 'short-lived-token',
      token_type: 'bearer',
      scope: 'docs:read extra',
      expires_in: 30,
    });
    expect((await provider.tokens())?.access_token).toBe('short-lived-token');
    now += 31_000;
    await expect(provider.tokens()).resolves.toBeUndefined();
    await expect(
      provider.validateResourceURL('https://mcp.example.com/api', 'https://mcp.example.com/other'),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('treats an omitted token scope as the requested scope', async () => {
    const store = new MemoryStore();
    store.values.set('machine-secret', { type: 'api-key', secret: 'secret' });
    const provider = await createClientCredentialsProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/api',
      auth: {
        mode: 'client-credentials',
        clientId: 'plinthway-service',
        issuer: 'https://auth.example.com',
        authentication: 'client-secret-post',
        credential: { source: 'keyring', id: 'machine-secret' },
        scopes: ['docs:read'],
        algorithm: 'RS256',
      },
      store,
    });
    await provider.saveTokens({ access_token: 'token-with-implicit-scope', token_type: 'Bearer' });
    await expect(provider.tokens()).resolves.toMatchObject({ scope: 'docs:read' });
  });

  it.each(['client-secret-basic', 'client-secret-post', 'private-key-jwt'] as const)(
    'executes a resource- and issuer-bound %s grant',
    async (authentication) => {
      const store = new MemoryStore();
      const secret =
        authentication === 'private-key-jwt'
          ? generateKeyPairSync('rsa', { modulusLength: 2048 })
              .privateKey.export({
                type: 'pkcs8',
                format: 'pem',
              })
              .toString()
          : 'machine-secret';
      store.values.set('credential', { type: 'api-key', secret });
      const provider = await createClientCredentialsProvider({
        serverId: 'docs',
        serverUrl: 'https://mcp.example.com/api',
        auth: {
          mode: 'client-credentials',
          clientId: 'plinthway-service',
          issuer: 'https://auth.example.com',
          authentication,
          credential: { source: 'keyring', id: 'credential' },
          scopes: ['docs:read'],
          algorithm: 'RS256',
        },
        store,
      });
      let tokenRequest: Request | undefined;
      const fetch: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.includes('oauth-protected-resource')) {
          return Promise.resolve(
            Response.json({
              resource: 'https://mcp.example.com/api',
              authorization_servers: ['https://auth.example.com'],
              scopes_supported: ['docs:read'],
            }),
          );
        }
        if (url.pathname.includes('oauth-authorization-server')) {
          return Promise.resolve(
            Response.json({
              issuer: 'https://auth.example.com',
              authorization_endpoint: 'https://auth.example.com/authorize',
              token_endpoint: 'https://auth.example.com/token',
              response_types_supported: ['code'],
              grant_types_supported: ['client_credentials'],
              token_endpoint_auth_methods_supported: [
                authentication === 'client-secret-basic'
                  ? 'client_secret_basic'
                  : authentication === 'client-secret-post'
                    ? 'client_secret_post'
                    : 'private_key_jwt',
              ],
            }),
          );
        }
        if (url.pathname === '/token') {
          tokenRequest = request;
          return Promise.resolve(
            Response.json({
              access_token: 'machine-access-token',
              token_type: 'Bearer',
              expires_in: 300,
              scope: 'docs:read',
            }),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      };

      await expect(
        authorizeOAuth(provider, {
          serverUrl: 'https://mcp.example.com/api',
          scope: 'docs:read',
          fetchFn: fetch,
        }),
      ).resolves.toBe('AUTHORIZED');
      const body = new URLSearchParams(await tokenRequest?.clone().text());
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('scope')).toBe('docs:read');
      expect(body.get('resource')).toBe('https://mcp.example.com/api');
      if (authentication === 'client-secret-basic') {
        expect(tokenRequest?.headers.get('authorization')).toMatch(/^Basic /u);
      } else if (authentication === 'client-secret-post') {
        expect(body.get('client_secret')).toBe('machine-secret');
      } else {
        expect(body.get('client_assertion_type')).toBe(
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        );
        expect(body.get('client_assertion')?.split('.')).toHaveLength(3);
      }
    },
  );
});

describe('Enterprise-Managed Authorization claims', () => {
  it('validates identity and ID-JAG issuer, audience, resource, type, scope, and expiry', () => {
    const now = 1_700_000_000;
    expect(
      validateJwtClaims(jwt({ iss: 'https://idp.example.com', aud: 'plinthway', exp: now + 60 }), {
        issuer: 'https://idp.example.com',
        audience: 'plinthway',
        now,
      }).iss,
    ).toBe('https://idp.example.com');
    const grant = jwt(
      {
        iss: 'https://idp.example.com',
        aud: 'https://auth.example.com',
        resource: 'https://mcp.example.com/api',
        exp: now + 60,
        scope: 'docs:read extra',
      },
      { alg: 'RS256', typ: 'oauth-id-jag+jwt' },
    );
    expect(
      validateJwtAuthorizationGrant(grant, {
        issuer: 'https://idp.example.com',
        audience: 'https://auth.example.com',
        resource: 'https://mcp.example.com/api',
        scopes: ['docs:read'],
        now,
      }).scope,
    ).toBe('docs:read extra');
    expect(() =>
      validateJwtAuthorizationGrant(grant, {
        issuer: 'https://idp.example.com',
        audience: 'https://wrong.example.com',
        resource: 'https://mcp.example.com/api',
        scopes: ['docs:read'],
        now,
      }),
    ).toThrow(/audience/u);
  });

  it('stores an identity assertion and performs the bound ID-JAG exchange', async () => {
    const now = 1_700_000_000;
    const store = new MemoryStore();
    store.values.set('mcp-secret', { type: 'api-key', secret: 'mcp-client-secret' });
    store.values.set('idp-secret', { type: 'api-key', secret: 'idp-client-secret' });
    const profile = {
      issuer: 'https://idp.example.com',
      clientId: 'plinthway-desktop',
      clientCredential: { source: 'keyring' as const, id: 'idp-secret' },
      scopes: ['openid'],
      resources: [
        {
          resource: 'https://mcp.example.com/api',
          authorizationServer: 'https://auth.example.com',
          clientId: 'plinthway-mcp',
          credential: { source: 'keyring' as const, id: 'mcp-secret' },
          scopes: ['docs:read'],
        },
      ],
    };
    const identity = jwt({
      iss: profile.issuer,
      aud: profile.clientId,
      sub: 'employee-1',
      exp: now + 300,
    });
    await storeEnterpriseIdentityAssertion({
      managedProfile: 'workforce',
      profile,
      assertion: identity,
      store,
      now,
    });
    expect(store.values.get(enterpriseIdentityCredentialKey('workforce'))).toMatchObject({
      type: 'mcp-identity',
      subject: 'employee-1',
    });

    const grant = jwt(
      {
        iss: profile.issuer,
        aud: 'https://auth.example.com',
        resource: 'https://mcp.example.com/api',
        exp: now + 60,
        scope: 'docs:read',
      },
      { alg: 'RS256', typ: 'oauth-id-jag+jwt' },
    );
    let exchangeBody: URLSearchParams | undefined;
    const provider = await createEnterpriseAuthorizationProvider({
      serverId: 'docs',
      serverUrl: 'https://mcp.example.com/api',
      managedProfile: 'workforce',
      profile,
      store,
      now: () => now * 1_000,
      fetch: async (input, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          exchangeBody = new URLSearchParams(await new Request(input, init).text());
          return new Response(
            JSON.stringify({
              access_token: grant,
              issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
              token_type: 'N_A',
              expires_in: 60,
              scope: 'docs:read',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            issuer: profile.issuer,
            authorization_endpoint: 'https://idp.example.com/authorize',
            token_endpoint: 'https://idp.example.com/token',
            response_types_supported: ['code'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    // CrossAppAccessProvider consumes this back-compatibility hook internally.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    provider.saveAuthorizationServerUrl('https://auth.example.com');
    provider.saveResourceUrl('https://mcp.example.com/api');
    const params = await provider.prepareTokenRequest('docs:read');

    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')).toBe(grant);
    expect(exchangeBody?.get('requested_token_type')).toBe(
      'urn:ietf:params:oauth:token-type:id-jag',
    );
    expect(exchangeBody?.get('audience')).toBe('https://auth.example.com');
    expect(exchangeBody?.get('resource')).toBe('https://mcp.example.com/api');
    expect(exchangeBody?.get('subject_token')).toBe(identity);
  });
});
