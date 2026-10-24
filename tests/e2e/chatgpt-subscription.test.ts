import { createServer } from 'node:http';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { NativeChatGptOAuth } from '../../packages/auth/src/index.js';
import {
  chatGptAdapterFactory,
  ProfileModelResolver,
  UnifiedLLMRuntime,
} from '../../packages/llm-runtime/src/index.js';
import type { LLMRequest } from '../../packages/shared/src/index.js';
import { createChatGptFetchFixture } from '../mocks/chatgpt-server.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  server.close();
  await once(server, 'close');
  return address.port;
}

function formBody(body: BodyInit | null | undefined): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === 'string') return new URLSearchParams(body);
  throw new TypeError('Expected a form-encoded request body');
}

describe('ChatGPT subscription end to end', () => {
  it('performs the native PKCE/OIDC callback with the published dynamic-agent parameters', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
    let authorizationUrl: URL | undefined;
    let tokenRequest: URLSearchParams | undefined;
    const port = await availablePort();
    const oauth = new NativeChatGptOAuth({
      authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
      tokenEndpoint: 'https://fixture.test/token',
      jwksEndpoint: 'https://fixture.test/jwks',
      revocationEndpoint: 'https://fixture.test/revoke',
      fetch: async (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
        if (url === 'https://fixture.test/jwks') return Response.json({ keys: [jwk] });
        if (url === 'https://fixture.test/token') {
          if (authorizationUrl === undefined) throw new Error('authorization URL missing');
          tokenRequest = formBody(init?.body);
          const idToken = await new SignJWT({
            email: 'user@example.com',
            nonce: authorizationUrl.searchParams.get('nonce'),
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
            .setIssuer('https://auth.openai.com')
            .setAudience('oaiapp-fixture')
            .setSubject('subject-one')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          return Response.json({
            access_token: 'chatgpt-access-canary',
            refresh_token: 'chatgpt-refresh-canary',
            id_token: idToken,
            expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      openUrl: async (value) => {
        authorizationUrl = new URL(value);
        const callback = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '');
        callback.searchParams.set('client_id', 'oaiapp-fixture');
        await fetch(callback);
      },
    });

    await expect(oauth.signIn({ hostId: 'host-one', callbackPort: port })).resolves.toMatchObject({
      identity: { subject: 'subject-one', email: 'user@example.com' },
      clientId: 'oaiapp-fixture',
      accessToken: 'chatgpt-access-canary',
    });
    expect(authorizationUrl?.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorizationUrl?.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(authorizationUrl?.searchParams.get('ext_agent_host_id')).toBe('host-one');
    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl?.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(tokenRequest?.get('client_id')).toBe('oaiapp-fixture');
  });

  it('reuses an issued client registration without exposing returning-login hints', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
    let browserUrl: URL | undefined;
    let displayedUrl: URL | undefined;
    const port = await availablePort();
    const oauth = new NativeChatGptOAuth({
      tokenEndpoint: 'https://fixture.test/token',
      jwksEndpoint: 'https://fixture.test/jwks',
      fetch: async (input) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
        if (url === 'https://fixture.test/jwks') return Response.json({ keys: [jwk] });
        if (url === 'https://fixture.test/token') {
          if (browserUrl === undefined) throw new Error('authorization URL missing');
          const idToken = await new SignJWT({ nonce: browserUrl.searchParams.get('nonce') })
            .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
            .setIssuer('https://auth.openai.com')
            .setAudience('oaiapp-fixture')
            .setSubject('subject-one')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          return Response.json({
            access_token: 'returning-access',
            refresh_token: 'returning-refresh',
            id_token: idToken,
            expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      openUrl: async (value) => {
        browserUrl = new URL(value);
        const callback = new URL(browserUrl.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', browserUrl.searchParams.get('state') ?? '');
        await fetch(callback);
      },
    });

    await expect(
      oauth.signIn({
        hostId: 'host-one',
        callbackPort: port,
        registration: {
          clientId: 'oaiapp-fixture',
          idToken: 'retained-id-token',
          email: 'user@example.com',
        },
        onAuthorizationUrl: (value) => {
          displayedUrl = new URL(value);
        },
      }),
    ).resolves.toMatchObject({ clientId: 'oaiapp-fixture', accessToken: 'returning-access' });
    expect(browserUrl?.searchParams.get('client_id')).toBe('oaiapp-fixture');
    expect(browserUrl?.searchParams.get('agent_name_hint')).toBeNull();
    expect(browserUrl?.searchParams.get('id_token_hint')).toBe('retained-id-token');
    expect(browserUrl?.searchParams.get('login_hint')).toBe('user@example.com');
    expect(displayedUrl?.searchParams.get('id_token_hint')).toBeNull();
    expect(displayedUrl?.searchParams.get('login_hint')).toBeNull();
  });

  it('discovers revocation and sends the issued client registration', async () => {
    const requests: Array<{ url: string; body?: URLSearchParams }> = [];
    const oauth = new NativeChatGptOAuth({
      fetch: (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
        requests.push({
          url,
          ...(init?.body === undefined ? {} : { body: formBody(init.body) }),
        });
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Promise.resolve(
            Response.json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' }),
          );
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });

    await expect(
      oauth.revoke({
        clientId: 'oaiapp-fixture',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: ['chatgpt.tokens.use.direct'],
        identity: { subject: 'subject-one' },
      }),
    ).resolves.toBe(true);
    expect(requests[1]?.url).toBe('https://auth.openai.com/oauth/revoke');
    expect(requests[1]?.body?.get('token')).toBe('refresh');
    expect(requests[1]?.body?.get('token_type_hint')).toBe('refresh_token');
    expect(requests[1]?.body?.get('client_id')).toBe('oaiapp-fixture');
  });

  it('streams a namespaced tool call through the strict Responses adapter', async () => {
    const fixture = createChatGptFetchFixture();
    const accounts = {
      withAccessToken: async <T>(_connectionId: string, operation: (token: string) => Promise<T>) =>
        operation('chatgpt-access-canary'),
    };
    const resolver = new ProfileModelResolver({
      registry: {
        get: () =>
          Promise.reject(
            Object.assign(new Error('not in Models.dev'), { code: 'MODEL_NOT_FOUND' }),
          ),
      },
      credentials: { get: () => Promise.reject(new Error('API key must not be read')) },
      adapterFactories: {
        'openai-chatgpt': chatGptAdapterFactory({ accounts, fetch: fixture.fetch }),
      },
    });
    const runtime = new UnifiedLLMRuntime({ resolver });
    const model = await runtime.resolve(
      'chatgpt/gpt-test',
      { toolCalls: true },
      {
        profileId: 'default',
        providers: {
          chatgpt: {
            adapter: 'openai-chatgpt',
            auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'account-one' },
            models: { 'gpt-test': { name: 'GPT Test', toolCalls: true } },
          },
        },
      },
    );
    const request: LLMRequest = {
      model,
      messages: [
        { role: 'system', content: 'Use local tools when helpful.' },
        { role: 'user', content: 'Show the current directory.' },
      ],
      tools: [
        {
          name: 'shell.run',
          description: 'Run a shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      parameters: { temperature: 0.9, maxOutputTokens: 100 },
    };

    const events = [];
    for await (const event of runtime.stream(request)) events.push(event);
    expect(events).toContainEqual({
      type: 'tool-call',
      callId: 'call-1',
      toolName: 'shell.run',
      input: { command: 'pwd' },
    });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      authorization: 'Bearer chatgpt-access-canary',
      body: { store: false, stream: true },
    });
    expect(fixture.requests[0]?.body).not.toHaveProperty('temperature');
    expect(fixture.requests[0]?.body).not.toHaveProperty('max_output_tokens');
  });
});
