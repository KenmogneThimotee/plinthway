import { createHash, randomBytes } from 'node:crypto';

import type { CredentialStore } from '@plinthway/auth';
import type { ManagedAuthorizationProfile } from '@plinthway/config';
import { PlinthwayError, registerRedactionSecret } from '@plinthway/shared';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

import { storeEnterpriseIdentityAssertion, validateJwtClaims } from './auth-extensions.js';
import { startOAuthLoopbackCallback, type OAuthLoopbackCallback } from './oauth-loopback.js';
import type { McpOAuthAuthorizationInput, McpOAuthAuthorizationResult } from './oauth-provider.js';

interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly code_challenge_methods_supported?: readonly string[];
}

interface PendingLogin {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly metadata: OidcMetadata;
  readonly loopback: OAuthLoopbackCallback;
  readonly completion: Promise<void>;
}

interface EnterpriseLoginRegistration {
  readonly managedProfile: string;
  readonly profile: ManagedAuthorizationProfile;
  readonly store: CredentialStore;
  readonly fetch: typeof globalThis.fetch;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity provider returned invalid JSON');
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new PlinthwayError('AUTH_FAILED', `Enterprise identity metadata is missing ${key}`);
  }
  return candidate;
}

function sameUrl(left: string, right: string): boolean {
  return new URL(left).href === new URL(right).href;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function discoverOidc(
  profile: ManagedAuthorizationProfile,
  fetchFn: typeof globalThis.fetch,
): Promise<OidcMetadata> {
  const issuer = new URL(profile.issuer);
  const issuerPath = issuer.pathname.replace(/\/$/u, '');
  const discovery = new URL(`${issuerPath}/.well-known/openid-configuration`, issuer.origin);
  const response = await fetchFn(discovery);
  if (!response.ok) {
    throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity-provider discovery failed');
  }
  const value = asObject(await response.json());
  const metadata: OidcMetadata = {
    issuer: stringProperty(value, 'issuer'),
    authorization_endpoint: stringProperty(value, 'authorization_endpoint'),
    token_endpoint: stringProperty(value, 'token_endpoint'),
    jwks_uri: stringProperty(value, 'jwks_uri'),
    ...(Array.isArray(value.code_challenge_methods_supported)
      ? {
          code_challenge_methods_supported: value.code_challenge_methods_supported.filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        }
      : {}),
  };
  if (!sameUrl(metadata.issuer, profile.issuer)) {
    throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity-provider issuer did not match');
  }
  if (metadata.code_challenge_methods_supported?.includes('S256') === false) {
    throw new PlinthwayError(
      'AUTH_FAILED',
      'Enterprise identity provider does not support PKCE S256',
    );
  }
  return metadata;
}

export interface EnterpriseOidcAuthorizationControllerOptions {
  readonly now?: () => number;
  readonly onAuthorized?: (serverId: string) => void | Promise<void>;
}

export class EnterpriseOidcAuthorizationController {
  readonly #registrations = new Map<string, EnterpriseLoginRegistration>();
  readonly #pending = new Map<string, PendingLogin>();
  readonly #errors = new Map<string, Error>();
  readonly #now: () => number;
  #onAuthorized: (serverId: string) => void | Promise<void>;

  constructor(options: EnterpriseOidcAuthorizationControllerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onAuthorized = options.onAuthorized ?? (() => undefined);
  }

  setOnAuthorized(handler: (serverId: string) => void | Promise<void>): void {
    this.#onAuthorized = handler;
  }

  register(
    serverId: string,
    registration: EnterpriseLoginRegistration,
  ): (input?: McpOAuthAuthorizationInput) => Promise<McpOAuthAuthorizationResult> {
    this.#registrations.set(serverId, registration);
    return (input = {}) => this.authorize(serverId, input);
  }

  async #hasIdentity(registration: EnterpriseLoginRegistration): Promise<boolean> {
    const credential = await registration.store.get(
      `mcp-enterprise-identity:${registration.managedProfile}`,
    );
    if (
      credential?.type !== 'mcp-identity' ||
      credential.expiresAt <= this.#now() ||
      credential.issuer !== registration.profile.issuer ||
      credential.audience !== registration.profile.clientId
    ) {
      return false;
    }
    try {
      validateJwtClaims(credential.assertion, {
        issuer: registration.profile.issuer,
        audience: registration.profile.clientId,
        now: Math.floor(this.#now() / 1_000),
      });
      registerRedactionSecret(credential.assertion);
      return true;
    } catch {
      await registration.store.delete(`mcp-enterprise-identity:${registration.managedProfile}`);
      return false;
    }
  }

  async #complete(
    serverId: string,
    pending: PendingLogin,
    input: Required<Pick<McpOAuthAuthorizationInput, 'code' | 'state'>> &
      Pick<McpOAuthAuthorizationInput, 'issuer'>,
  ): Promise<void> {
    const registration = this.#registrations.get(serverId);
    if (registration === undefined)
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise login is not configured');
    if (input.state !== pending.state)
      throw new PlinthwayError('AUTH_FAILED', 'OAuth callback state did not match');
    if (input.issuer !== undefined && !sameUrl(input.issuer, registration.profile.issuer)) {
      throw new PlinthwayError('AUTH_FAILED', 'OAuth callback issuer did not match');
    }
    let clientSecret: string | undefined;
    if (registration.profile.clientCredential !== undefined) {
      const credential = await registration.store.get(registration.profile.clientCredential.id);
      if (credential?.type !== 'api-key') {
        throw new PlinthwayError(
          'AUTH_FAILED',
          'Managed identity-provider credential is unavailable',
        );
      }
      clientSecret = credential.secret;
      registerRedactionSecret(credential.secret);
    }
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: pending.redirectUri,
      client_id: registration.profile.clientId,
      code_verifier: pending.codeVerifier,
    });
    if (clientSecret !== undefined) params.set('client_secret', clientSecret);
    const response = await registration.fetch(pending.metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!response.ok)
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity token exchange failed');
    const tokenResponse = asObject(await response.json());
    const idToken = stringProperty(tokenResponse, 'id_token');
    const jwksResponse = await registration.fetch(pending.metadata.jwks_uri);
    if (!jwksResponse.ok)
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity signing keys are unavailable');
    const jwksValue = asObject(await jwksResponse.json());
    if (!Array.isArray(jwksValue.keys)) {
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity signing keys are invalid');
    }
    const jwks = jwksValue as unknown as JSONWebKeySet;
    const verified = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: registration.profile.issuer,
      audience: registration.profile.clientId,
      currentDate: new Date(this.#now()),
    });
    if (verified.payload.nonce !== pending.nonce) {
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity assertion nonce did not match');
    }
    await storeEnterpriseIdentityAssertion({
      managedProfile: registration.managedProfile,
      profile: registration.profile,
      assertion: idToken,
      store: registration.store,
      now: Math.floor(this.#now() / 1_000),
      nonce: pending.nonce,
    });
  }

  async authorize(
    serverId: string,
    input: McpOAuthAuthorizationInput = {},
  ): Promise<McpOAuthAuthorizationResult> {
    const registration = this.#registrations.get(serverId);
    if (registration === undefined) {
      throw new PlinthwayError('AUTH_FAILED', `Enterprise login is not configured for ${serverId}`);
    }
    const previousError = this.#errors.get(serverId);
    if (previousError !== undefined) {
      this.#errors.delete(serverId);
      throw previousError;
    }
    if (await this.#hasIdentity(registration)) return { state: 'authorized' };
    const existing = this.#pending.get(serverId);
    if (input.code !== undefined) {
      if (existing === undefined || input.state === undefined) {
        throw new PlinthwayError('AUTH_FAILED', 'Enterprise OAuth transaction is not active');
      }
      await this.#complete(serverId, existing, {
        code: input.code,
        state: input.state,
        ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
      });
      this.#pending.delete(serverId);
      await existing.loopback.close();
      return { state: 'authorized' };
    }
    if (existing !== undefined) {
      const authorizationUrl = new URL(existing.metadata.authorization_endpoint);
      authorizationUrl.searchParams.set('client_id', registration.profile.clientId);
      authorizationUrl.searchParams.set('redirect_uri', existing.redirectUri);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('scope', registration.profile.scopes.join(' '));
      authorizationUrl.searchParams.set('state', existing.state);
      authorizationUrl.searchParams.set('nonce', existing.nonce);
      authorizationUrl.searchParams.set('code_challenge', pkceChallenge(existing.codeVerifier));
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      return {
        state: 'redirect',
        authorizationUrl: authorizationUrl.href,
        waitForCompletion: (signal) => {
          if (signal?.aborted === true) {
            if (this.#pending.get(serverId) === existing) this.#pending.delete(serverId);
            void existing.loopback.close();
            return Promise.reject(
              new PlinthwayError('CANCELLED', 'Enterprise login was cancelled'),
            );
          }
          if (signal === undefined) return existing.completion;
          return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              if (this.#pending.get(serverId) === existing) this.#pending.delete(serverId);
              void existing.loopback.close();
              reject(new PlinthwayError('CANCELLED', 'Enterprise login was cancelled'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            void existing.completion.then(
              () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              },
              (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(
                  error instanceof Error
                    ? error
                    : new PlinthwayError('AUTH_FAILED', 'Enterprise login failed'),
                );
              },
            );
          });
        },
      };
    }
    const metadata = await discoverOidc(registration.profile, registration.fetch);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const loopback = await startOAuthLoopbackCallback({ expectedState: state });
    // The completion handlers close over the fully constructed transaction below.
    // eslint-disable-next-line prefer-const
    let pending: PendingLogin;
    const completion = loopback.result
      .then(async (result) => {
        await this.#complete(serverId, pending, {
          code: result.code,
          state: result.state,
          ...(result.issuer === undefined ? {} : { issuer: result.issuer }),
        });
        await this.#onAuthorized(serverId);
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Error
            ? error
            : new PlinthwayError('AUTH_FAILED', 'Enterprise login failed');
        this.#errors.set(serverId, failure);
        throw failure;
      })
      .finally(() => {
        if (this.#pending.get(serverId) === pending) this.#pending.delete(serverId);
        return loopback.close();
      });
    pending = {
      state,
      nonce,
      codeVerifier,
      redirectUri: loopback.redirectUrl.href,
      metadata,
      loopback,
      completion,
    };
    this.#pending.set(serverId, pending);
    void completion.catch(() => undefined);
    return this.authorize(serverId);
  }
}
