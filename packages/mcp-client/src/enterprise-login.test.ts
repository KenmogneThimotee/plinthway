import { generateKeyPairSync } from 'node:crypto';

import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Credential, CredentialStore } from '@plinthway/auth';

import { EnterpriseOidcAuthorizationController } from './enterprise-login.js';

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

describe('enterprise OIDC login', () => {
  it('uses random loopback PKCE, verifies the ID token, and stores the assertion', async () => {
    const now = 1_700_000_000;
    const issuer = 'https://idp.example.com';
    const clientId = 'plinthway-desktop';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'enterprise-test';
    jwk.use = 'sig';
    const store = new MemoryStore();
    let nonce = '';
    let tokenBody: URLSearchParams | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            code_challenge_methods_supported: ['S256'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname === '/token') {
        tokenBody = new URLSearchParams(await new Request(input, init).text());
        const idToken = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'enterprise-test', typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject('employee-1')
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/jwks') {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    };
    const profile = {
      issuer,
      clientId,
      scopes: ['openid'],
      resources: [
        {
          resource: 'https://mcp.example.com/api',
          authorizationServer: 'https://auth.example.com',
          clientId: 'plinthway-mcp',
          credential: { source: 'keyring' as const, id: 'mcp-secret' },
          scopes: [],
        },
      ],
    };
    const controller = new EnterpriseOidcAuthorizationController({ now: () => now * 1_000 });
    const authorize = controller.register('docs', {
      managedProfile: 'workforce',
      profile,
      store,
      fetch,
    });

    const started = await authorize();
    expect(started.state).toBe('redirect');
    const authorizationUrl = new URL(started.authorizationUrl ?? 'missing:');
    nonce = authorizationUrl.searchParams.get('nonce') ?? '';
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u,
    );

    const callback = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? 'missing:');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '');
    callback.searchParams.set('iss', issuer);
    await expect(globalThis.fetch(callback)).resolves.toMatchObject({ status: 200 });
    await expect(started.waitForCompletion?.()).resolves.toBeUndefined();
    await expect(authorize()).resolves.toEqual({ state: 'authorized' });
    expect(tokenBody?.get('grant_type')).toBe('authorization_code');
    expect(tokenBody?.get('code_verifier')).toBeTruthy();
    expect(store.values.get('mcp-enterprise-identity:workforce')).toMatchObject({
      type: 'mcp-identity',
      subject: 'employee-1',
      issuer,
      audience: clientId,
    });
  });
});
