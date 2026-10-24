import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { PlinthwayError } from '@plinthway/shared';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';

import {
  CHATGPT_SCOPES,
  type ChatGptIdentity,
  type ChatGptLoginOptions,
  type ChatGptOAuthFlow,
  type ChatGptTokenSet,
} from './contracts.js';

const CLIENT_ID = 'dynamic_agent_client';
const RESOURCE = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in: number;
  readonly scope?: string;
}

interface OAuthCallbackResult {
  readonly code: string;
  readonly clientId?: string;
}

export interface NativeChatGptOAuthOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly now?: () => number;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly jwksEndpoint?: string;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function tokenResponse(value: unknown): TokenResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('access_token' in value) ||
    typeof value.access_token !== 'string' ||
    value.access_token.length === 0 ||
    !('expires_in' in value) ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    ('refresh_token' in value &&
      value.refresh_token !== undefined &&
      typeof value.refresh_token !== 'string') ||
    ('id_token' in value && value.id_token !== undefined && typeof value.id_token !== 'string') ||
    ('scope' in value && value.scope !== undefined && typeof value.scope !== 'string')
  )
    throw new PlinthwayError('AUTH_FAILED', 'OpenAI returned an invalid token response');
  return value as TokenResponse;
}

function identity(payload: JWTPayload): ChatGptIdentity {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new PlinthwayError('AUTH_FAILED', 'OpenAI returned an ID token without a subject');
  }
  return {
    subject: payload.sub,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.name === 'string' ? { displayName: payload.name } : {}),
  };
}

async function waitForCallback(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`);
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        response.writeHead(400).end('Invalid authorization state');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error !== null || code === null) {
        response.writeHead(400).end('Authorization was not completed');
        cleanup();
        reject(
          new PlinthwayError('AUTH_FAILED', 'ChatGPT authorization was not completed', {
            providerError: error ?? 'missing_code',
          }),
        );
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Connected. You can return to Plinthway.');
      cleanup();
      const clientId = url.searchParams.get('client_id');
      resolve({ code, ...(clientId === null ? {} : { clientId }) });
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new PlinthwayError(
          'AUTH_FAILED',
          'Timed out waiting for the ChatGPT authorization callback',
        ),
      );
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      server.close();
    };
    server.once('error', (error) => {
      cleanup();
      reject(
        new PlinthwayError(
          'AUTH_FAILED',
          'Could not start the local authorization callback',
          {},
          { cause: error },
        ),
      );
    });
    server.listen(port, '127.0.0.1');
  });
}

export class NativeChatGptOAuth implements ChatGptOAuthFlow {
  readonly #fetch: typeof globalThis.fetch;
  readonly #openUrl: ((url: string) => Promise<void>) | undefined;
  readonly #now: () => number;
  readonly #authorize: string;
  readonly #token: string;
  readonly #revoke: string | undefined;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: NativeChatGptOAuthOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#openUrl = options.openUrl;
    this.#now = options.now ?? Date.now;
    this.#authorize = options.authorizationEndpoint ?? `${ISSUER}/api/accounts/authorize`;
    this.#token = options.tokenEndpoint ?? `${ISSUER}/api/accounts/oauth/token`;
    this.#revoke = options.revocationEndpoint;
    this.#jwks = createRemoteJWKSet(
      new URL(options.jwksEndpoint ?? `${ISSUER}/.well-known/jwks.json`),
      {
        [customFetch]: this.#fetch,
      },
    );
  }

  async signIn(
    options: ChatGptLoginOptions & {
      readonly hostId: string;
      readonly registration?: {
        readonly clientId: string;
        readonly idToken?: string;
        readonly email?: string;
      };
    },
  ): Promise<ChatGptTokenSet> {
    const initialRegistration = options.registration === undefined;
    const requestedClientId = options.registration?.clientId ?? CLIENT_ID;
    const port = options.callbackPort ?? 1455;
    const redirectUri = `http://127.0.0.1:${String(port)}/auth/callback`;
    const state = base64Url(randomBytes(32));
    const nonce = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(48));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(this.#authorize);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: requestedClientId,
      redirect_uri: redirectUri,
      scope: CHATGPT_SCOPES.join(' '),
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ext_agent_host_id: options.hostId,
      ...(initialRegistration ? { agent_name_hint: 'Plinthway' } : {}),
      ...(options.registration?.idToken === undefined
        ? {}
        : { id_token_hint: options.registration.idToken }),
      ...(options.registration?.email === undefined
        ? {}
        : { login_hint: options.registration.email }),
    }).toString();

    if (options.onAuthorizationUrl !== undefined) {
      const safeUrl = new URL(url);
      safeUrl.searchParams.delete('id_token_hint');
      safeUrl.searchParams.delete('login_hint');
      options.onAuthorizationUrl(safeUrl.toString());
    }
    const callback = waitForCallback(port, state, options.timeoutMs ?? 300_000);
    if (options.openBrowser !== false && this.#openUrl !== undefined) {
      try {
        await this.#openUrl(url.toString());
      } catch {
        // The callback remains active; the caller already received the safe URL.
      }
    }
    const callbackResult = await callback;
    const issuedClientId = callbackResult.clientId ?? options.registration?.clientId;
    if (issuedClientId === undefined || issuedClientId.length === 0) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'ChatGPT registration did not return an issued client ID',
      );
    }
    if (options.registration !== undefined && issuedClientId !== options.registration.clientId) {
      throw new PlinthwayError('AUTH_FAILED', 'ChatGPT returned a different client registration');
    }
    const response = await this.#fetch(this.#token, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callbackResult.code,
        client_id: issuedClientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    });
    if (!response.ok)
      throw new PlinthwayError('AUTH_FAILED', 'ChatGPT authorization exchange failed', {
        status: response.status,
      });
    const result = tokenResponse(await response.json());
    if (result.id_token === undefined || result.refresh_token === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'OpenAI did not return reusable ChatGPT credentials');
    }
    const verified = await jwtVerify(result.id_token, this.#jwks, {
      issuer: ISSUER,
      audience: issuedClientId,
    });
    if (verified.payload.nonce !== nonce)
      throw new PlinthwayError('AUTH_FAILED', 'OpenAI ID-token nonce did not match');
    return {
      clientId: issuedClientId,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      idToken: result.id_token,
      expiresAt: this.#now() + result.expires_in * 1000,
      scope: (result.scope ?? CHATGPT_SCOPES.join(' ')).split(/\s+/u).filter(Boolean),
      identity: identity(verified.payload),
    };
  }

  async refresh(tokens: ChatGptTokenSet, signal?: AbortSignal): Promise<ChatGptTokenSet> {
    const response = await this.#fetch(this.#token, {
      method: 'POST',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: tokens.clientId,
        resource: RESOURCE,
      }),
    });
    if (!response.ok) {
      let providerError: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === 'string') providerError = body.error;
      } catch {
        providerError = undefined;
      }
      throw new PlinthwayError('AUTH_FAILED', 'ChatGPT token refresh failed', {
        status: response.status,
        ...(providerError === undefined ? {} : { providerError }),
      });
    }
    const result = tokenResponse(await response.json());
    return {
      clientId: tokens.clientId,
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? tokens.refreshToken,
      ...(tokens.idToken === undefined ? {} : { idToken: tokens.idToken }),
      expiresAt: this.#now() + result.expires_in * 1000,
      scope: (result.scope ?? tokens.scope.join(' ')).split(/\s+/u).filter(Boolean),
      identity: tokens.identity,
    };
  }

  async revoke(tokens: ChatGptTokenSet): Promise<boolean> {
    try {
      let endpoint = this.#revoke;
      if (endpoint === undefined) {
        const discovery = await this.#fetch(`${ISSUER}/.well-known/openid-configuration`, {
          redirect: 'error',
        });
        if (!discovery.ok) return false;
        const value = (await discovery.json()) as { revocation_endpoint?: unknown };
        if (typeof value.revocation_endpoint !== 'string') return false;
        const discovered = new URL(value.revocation_endpoint);
        if (discovered.origin !== ISSUER) return false;
        endpoint = discovered.toString();
      }
      const response = await this.#fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: tokens.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: tokens.clientId,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
