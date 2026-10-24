import type { CredentialStore } from '@plinthway/auth';
import type { ManagedAuthorizationProfile } from '@plinthway/config';
import {
  CrossAppAccessProvider,
  createPrivateKeyJwtAuth,
  discoverAndRequestJwtAuthGrant,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import {
  canonicalJson,
  PlinthwayError,
  registerRedactionSecret,
  sha256,
  type JsonValue,
  type McpHttpAuth,
} from '@plinthway/shared';

type ClientCredentialsAuth = Extract<McpHttpAuth, { readonly mode: 'client-credentials' }>;

interface PersistedMachineTokens {
  readonly version: number;
  readonly issuer: string;
  readonly resource: string;
  readonly savedAt: number;
  readonly tokens: StoredOAuthTokens;
}

function json(value: unknown): Readonly<Record<string, JsonValue>> {
  return JSON.parse(canonicalJson(value)) as Readonly<Record<string, JsonValue>>;
}

function normalizedUrl(value: string | URL): string {
  return new URL(value).href;
}

function formComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

function assertIssuer(actual: string | undefined, expected: string, serverId: string): void {
  if (actual !== undefined && normalizedUrl(actual) !== normalizedUrl(expected)) {
    throw new PlinthwayError('AUTH_FAILED', 'OAuth authorization-server issuer did not match', {
      serverId,
    });
  }
}

function scopeSet(scope: string | undefined): ReadonlySet<string> {
  return new Set((scope ?? '').split(/\s+/u).filter(Boolean));
}

function assertScopes(
  actual: string | undefined,
  required: readonly string[],
  serverId: string,
): void {
  const granted = scopeSet(actual);
  if (required.some((scope) => !granted.has(scope))) {
    throw new PlinthwayError('AUTH_FAILED', 'OAuth token did not grant every configured scope', {
      serverId,
    });
  }
}

function effectiveScope(
  tokens: StoredOAuthTokens,
  requested: readonly string[],
): string | undefined {
  return tokens.scope ?? (requested.length === 0 ? undefined : requested.join(' '));
}

export interface CreateClientCredentialsProviderOptions {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly auth: ClientCredentialsAuth;
  readonly store: CredentialStore;
  readonly now?: () => number;
}

export class DurableClientCredentialsProvider implements OAuthClientProvider {
  readonly redirectUrl = undefined;
  readonly clientMetadata: OAuthClientMetadata;
  readonly addClientAuthentication: NonNullable<OAuthClientProvider['addClientAuthentication']>;
  readonly #serverId: string;
  readonly #resource: string;
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #clientSecret: string | undefined;
  readonly #scopes: readonly string[];
  readonly #store: CredentialStore;
  readonly #storeKey: string;
  readonly #now: () => number;
  readonly #credentialEndpoints: Set<string>;

  constructor(options: CreateClientCredentialsProviderOptions, secret: string) {
    this.#serverId = options.serverId;
    this.#resource = normalizedUrl(options.serverUrl);
    this.#issuer = normalizedUrl(options.auth.issuer);
    this.#clientId = options.auth.clientId;
    this.#scopes = [...options.auth.scopes];
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#credentialEndpoints = new Set();
    this.#storeKey = `mcp-client-credentials:${sha256(
      canonicalJson({ issuer: this.#issuer, resource: this.#resource, clientId: this.#clientId }),
    )}`;
    const method =
      options.auth.authentication === 'client-secret-basic'
        ? 'client_secret_basic'
        : options.auth.authentication === 'client-secret-post'
          ? 'client_secret_post'
          : 'private_key_jwt';
    this.clientMetadata = {
      client_name: 'Plinthway',
      redirect_uris: [],
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: method,
      scope: this.#scopes.join(' '),
    };
    if (options.auth.authentication === 'private-key-jwt') {
      const authenticate = createPrivateKeyJwtAuth({
        issuer: this.#clientId,
        subject: this.#clientId,
        privateKey: secret,
        alg: options.auth.algorithm,
      });
      this.addClientAuthentication = (headers, params, url, metadata) => {
        this.#credentialEndpoints.add(new URL(url).href);
        return authenticate(headers, params, url, metadata);
      };
    } else {
      this.#clientSecret = secret;
      this.addClientAuthentication = (headers, params, url) => {
        this.#credentialEndpoints.add(new URL(url).href);
        if (options.auth.authentication === 'client-secret-basic') {
          const encoded = Buffer.from(
            `${formComponent(this.#clientId)}:${formComponent(secret)}`,
          ).toString('base64');
          headers.set('Authorization', `Basic ${encoded}`);
        } else {
          params.set('client_id', this.#clientId);
          params.set('client_secret', secret);
        }
      };
    }
  }

  isCredentialDestination(url: URL): boolean {
    return this.#credentialEndpoints.has(url.href);
  }

  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation {
    assertIssuer(context?.issuer, this.#issuer, this.#serverId);
    return {
      client_id: this.#clientId,
      ...(this.#clientSecret === undefined ? {} : { client_secret: this.#clientSecret }),
      issuer: this.#issuer,
    };
  }

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    assertIssuer(context?.issuer, this.#issuer, this.#serverId);
    const credential = await this.#store.get(this.#storeKey);
    if (credential === null) return undefined;
    if (credential.type !== 'mcp-oauth') {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Stored machine OAuth credential has the wrong type',
        {
          serverId: this.#serverId,
        },
      );
    }
    const state = credential.state as unknown as PersistedMachineTokens;
    if (
      state.version !== 1 ||
      normalizedUrl(state.issuer) !== this.#issuer ||
      normalizedUrl(state.resource) !== this.#resource
    ) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Stored machine OAuth credential binding is invalid',
        {
          serverId: this.#serverId,
        },
      );
    }
    if (
      state.tokens.expires_in !== undefined &&
      this.#now() >= state.savedAt + state.tokens.expires_in * 1_000
    ) {
      await this.#store.delete(this.#storeKey);
      return undefined;
    }
    assertScopes(state.tokens.scope, this.#scopes, this.#serverId);
    registerRedactionSecret(state.tokens.access_token);
    if (state.tokens.refresh_token !== undefined)
      registerRedactionSecret(state.tokens.refresh_token);
    return state.tokens;
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    assertIssuer(context?.issuer ?? tokens.issuer, this.#issuer, this.#serverId);
    const scope = effectiveScope(tokens, this.#scopes);
    assertScopes(scope, this.#scopes, this.#serverId);
    registerRedactionSecret(tokens.access_token);
    if (tokens.refresh_token !== undefined) registerRedactionSecret(tokens.refresh_token);
    await this.#store.set(this.#storeKey, {
      type: 'mcp-oauth',
      state: json({
        version: 1,
        issuer: this.#issuer,
        resource: this.#resource,
        savedAt: this.#now(),
        tokens: { ...tokens, ...(scope === undefined ? {} : { scope }), issuer: this.#issuer },
      }),
    });
  }

  redirectToAuthorization(): never {
    throw new PlinthwayError('AUTH_FAILED', 'Client credentials authorization cannot redirect');
  }
  saveCodeVerifier(): void {}
  codeVerifier(): never {
    throw new PlinthwayError('AUTH_FAILED', 'Client credentials authorization does not use PKCE');
  }
  prepareTokenRequest(scope?: string): URLSearchParams {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const requested = scope ?? this.#scopes.join(' ');
    if (requested.length > 0) params.set('scope', requested);
    return params;
  }
  validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (normalizedUrl(serverUrl) !== this.#resource) {
      return Promise.reject(
        new PlinthwayError('AUTH_FAILED', 'OAuth transport resource did not match configuration', {
          serverId: this.#serverId,
        }),
      );
    }
    if (resource === undefined) return Promise.resolve(new URL(this.#resource));
    if (normalizedUrl(resource) !== this.#resource) {
      return Promise.reject(
        new PlinthwayError('AUTH_FAILED', 'OAuth resource did not match the MCP server', {
          serverId: this.#serverId,
        }),
      );
    }
    return Promise.resolve(new URL(this.#resource));
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.#store.delete(this.#storeKey);
  }
}

export async function createClientCredentialsProvider(
  options: CreateClientCredentialsProviderOptions,
): Promise<DurableClientCredentialsProvider> {
  if (options.auth.credential.source !== 'keyring') {
    throw new PlinthwayError('AUTH_FAILED', 'Machine credentials must come from the keyring', {
      serverId: options.serverId,
    });
  }
  const credential = await options.store.get(options.auth.credential.id);
  if (credential?.type !== 'api-key') {
    throw new PlinthwayError('AUTH_FAILED', 'Configured machine credential is unavailable', {
      serverId: options.serverId,
    });
  }
  registerRedactionSecret(credential.secret);
  return new DurableClientCredentialsProvider(options, credential.secret);
}

export interface JwtClaimValidationOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly now?: number;
  readonly nonce?: string;
}

function parseJwt(token: string): {
  readonly header: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined) {
    throw new PlinthwayError('AUTH_FAILED', 'Identity assertion is not a JWT');
  }
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Readonly<
        Record<string, unknown>
      >,
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Readonly<
        Record<string, unknown>
      >,
    };
  } catch (error) {
    throw new PlinthwayError(
      'AUTH_FAILED',
      'Identity assertion JWT is malformed',
      {},
      { cause: error },
    );
  }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

export function validateJwtClaims(
  token: string,
  options: JwtClaimValidationOptions,
): Readonly<Record<string, unknown>> {
  const { claims } = parseJwt(token);
  if (claims.iss !== options.issuer) {
    throw new PlinthwayError('AUTH_FAILED', 'Identity assertion issuer did not match');
  }
  if (!audienceIncludes(claims.aud, options.audience)) {
    throw new PlinthwayError('AUTH_FAILED', 'Identity assertion audience did not match');
  }
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new PlinthwayError('AUTH_FAILED', 'Identity assertion is expired');
  }
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new PlinthwayError('AUTH_FAILED', 'Identity assertion nonce did not match');
  }
  return claims;
}

export interface JwtAuthorizationGrantValidationOptions extends JwtClaimValidationOptions {
  readonly resource: string;
  readonly scopes: readonly string[];
}

export function validateJwtAuthorizationGrant(
  token: string,
  options: JwtAuthorizationGrantValidationOptions,
): Readonly<Record<string, unknown>> {
  const parsed = parseJwt(token);
  if (parsed.header.typ !== 'oauth-id-jag+jwt') {
    throw new PlinthwayError('AUTH_FAILED', 'JWT Authorization Grant has an invalid type');
  }
  const claims = validateJwtClaims(token, options);
  if (claims.resource !== options.resource) {
    throw new PlinthwayError('AUTH_FAILED', 'JWT Authorization Grant resource did not match');
  }
  const scope = typeof claims.scope === 'string' ? claims.scope : undefined;
  assertScopes(scope, options.scopes, 'enterprise');
  return claims;
}

export function enterpriseIdentityCredentialKey(managedProfile: string): string {
  return `mcp-enterprise-identity:${managedProfile}`;
}

export interface StoreEnterpriseIdentityAssertionOptions {
  readonly managedProfile: string;
  readonly profile: ManagedAuthorizationProfile;
  readonly assertion: string;
  readonly store: CredentialStore;
  readonly now?: number;
  readonly nonce?: string;
}

export async function storeEnterpriseIdentityAssertion(
  options: StoreEnterpriseIdentityAssertionOptions,
): Promise<void> {
  const claims = validateJwtClaims(options.assertion, {
    issuer: options.profile.issuer,
    audience: options.profile.clientId,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || typeof claims.exp !== 'number') {
    throw new PlinthwayError(
      'AUTH_FAILED',
      'Identity assertion is missing required subject claims',
    );
  }
  registerRedactionSecret(options.assertion);
  await options.store.set(enterpriseIdentityCredentialKey(options.managedProfile), {
    type: 'mcp-identity',
    assertion: options.assertion,
    issuer: options.profile.issuer,
    audience: options.profile.clientId,
    subject: claims.sub,
    expiresAt: claims.exp * 1_000,
  });
}

function unionScopes(
  ...values: readonly (string | readonly string[] | undefined)[]
): readonly string[] {
  const scopes = new Set<string>();
  for (const value of values) {
    const entries = typeof value === 'string' ? value.split(/\s+/u) : (value ?? []);
    for (const scope of entries) if (scope.length > 0) scopes.add(scope);
  }
  return [...scopes].sort();
}

export interface CreateEnterpriseAuthorizationProviderOptions {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly managedProfile: string;
  readonly profile: ManagedAuthorizationProfile;
  readonly store: CredentialStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class DurableEnterpriseAuthorizationProvider implements OAuthClientProvider {
  readonly redirectUrl = undefined;
  readonly clientMetadata: OAuthClientMetadata;
  readonly addClientAuthentication: NonNullable<OAuthClientProvider['addClientAuthentication']>;
  readonly #delegate: CrossAppAccessProvider;
  readonly #serverId: string;
  readonly #resource: string;
  readonly #issuer: string;
  readonly #store: CredentialStore;
  readonly #storeKey: string;
  readonly #now: () => number;
  readonly #credentialEndpoints: Set<string>;

  constructor(
    options: CreateEnterpriseAuthorizationProviderOptions,
    delegate: CrossAppAccessProvider,
    issuer: string,
    resource: string,
    clientId: string,
    clientSecret: string,
  ) {
    this.#delegate = delegate;
    this.clientMetadata = delegate.clientMetadata;
    this.#serverId = options.serverId;
    this.#issuer = normalizedUrl(issuer);
    this.#resource = normalizedUrl(resource);
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#credentialEndpoints = new Set();
    this.#storeKey = `mcp-enterprise:${sha256(
      canonicalJson({ issuer: this.#issuer, resource: this.#resource, clientId }),
    )}`;
    this.addClientAuthentication = (headers, _params, url) => {
      this.#credentialEndpoints.add(new URL(url).href);
      const encoded = Buffer.from(
        `${formComponent(clientId)}:${formComponent(clientSecret)}`,
      ).toString('base64');
      headers.set('Authorization', `Basic ${encoded}`);
    };
  }

  isCredentialDestination(url: URL): boolean {
    return this.#credentialEndpoints.has(url.href);
  }

  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation {
    assertIssuer(context?.issuer, this.#issuer, this.#serverId);
    return this.#delegate.clientInformation();
  }
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    assertIssuer(context?.issuer, this.#issuer, this.#serverId);
    const credential = await this.#store.get(this.#storeKey);
    if (credential === null) return undefined;
    if (credential.type !== 'mcp-oauth') {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Stored enterprise OAuth credential has the wrong type',
        {
          serverId: this.#serverId,
        },
      );
    }
    const state = credential.state as unknown as PersistedMachineTokens;
    if (
      state.version !== 1 ||
      normalizedUrl(state.issuer) !== this.#issuer ||
      normalizedUrl(state.resource) !== this.#resource
    ) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Stored enterprise OAuth credential binding is invalid',
        {
          serverId: this.#serverId,
        },
      );
    }
    if (
      state.tokens.expires_in !== undefined &&
      this.#now() >= state.savedAt + state.tokens.expires_in * 1_000
    ) {
      await this.#store.delete(this.#storeKey);
      return undefined;
    }
    registerRedactionSecret(state.tokens.access_token);
    if (state.tokens.refresh_token !== undefined)
      registerRedactionSecret(state.tokens.refresh_token);
    return state.tokens;
  }
  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    assertIssuer(context?.issuer ?? tokens.issuer, this.#issuer, this.#serverId);
    registerRedactionSecret(tokens.access_token);
    if (tokens.refresh_token !== undefined) registerRedactionSecret(tokens.refresh_token);
    await this.#store.set(this.#storeKey, {
      type: 'mcp-oauth',
      state: json({
        version: 1,
        issuer: this.#issuer,
        resource: this.#resource,
        savedAt: this.#now(),
        tokens: { ...tokens, issuer: this.#issuer },
      }),
    });
  }
  redirectToAuthorization(): never {
    throw new PlinthwayError('AUTH_FAILED', 'Enterprise authorization requires an identity login');
  }
  saveCodeVerifier(): void {}
  codeVerifier(): never {
    throw new PlinthwayError(
      'AUTH_FAILED',
      'Enterprise ID-JAG authorization does not use MCP PKCE',
    );
  }
  saveAuthorizationServerUrl(value: string): void {
    assertIssuer(value, this.#issuer, this.#serverId);
    // CrossAppAccessProvider still uses these deprecated hooks internally to prepare ID-JAG.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    this.#delegate.saveAuthorizationServerUrl(value);
  }
  authorizationServerUrl(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return this.#delegate.authorizationServerUrl();
  }
  saveResourceUrl(value: string): void {
    if (normalizedUrl(value) !== this.#resource) {
      throw new PlinthwayError('AUTH_FAILED', 'Enterprise OAuth resource did not match', {
        serverId: this.#serverId,
      });
    }
    this.#delegate.saveResourceUrl?.(value);
  }
  resourceUrl(): string | undefined {
    return this.#delegate.resourceUrl?.();
  }
  prepareTokenRequest(scope?: string): Promise<URLSearchParams> {
    return this.#delegate.prepareTokenRequest(scope);
  }
  validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (
      normalizedUrl(serverUrl) !== this.#resource ||
      (resource !== undefined && normalizedUrl(resource) !== this.#resource)
    ) {
      return Promise.reject(
        new PlinthwayError('AUTH_FAILED', 'Enterprise OAuth resource did not match configuration', {
          serverId: this.#serverId,
        }),
      );
    }
    return Promise.resolve(new URL(this.#resource));
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.#store.delete(this.#storeKey);
  }
}

export async function createEnterpriseAuthorizationProvider(
  options: CreateEnterpriseAuthorizationProviderOptions,
): Promise<DurableEnterpriseAuthorizationProvider> {
  const resource = options.profile.resources.find(
    (candidate) => normalizedUrl(candidate.resource) === normalizedUrl(options.serverUrl),
  );
  if (resource === undefined) {
    throw new PlinthwayError(
      'AUTH_FAILED',
      'The managed enterprise profile has no registration for this MCP resource',
      { serverId: options.serverId, managedProfile: options.managedProfile },
    );
  }
  const mcpCredential = await options.store.get(resource.credential.id);
  if (mcpCredential?.type !== 'api-key') {
    throw new PlinthwayError('AUTH_FAILED', 'Managed MCP client credential is unavailable', {
      serverId: options.serverId,
    });
  }
  registerRedactionSecret(mcpCredential.secret);
  const delegate = new CrossAppAccessProvider({
    clientId: resource.clientId,
    clientSecret: mcpCredential.secret,
    expectedIssuer: resource.authorizationServer,
    ...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
    assertion: async (context) => {
      if (
        normalizedUrl(context.authorizationServerUrl) !==
        normalizedUrl(resource.authorizationServer)
      ) {
        throw new PlinthwayError(
          'AUTH_FAILED',
          'Enterprise authorization-server issuer did not match',
        );
      }
      if (normalizedUrl(context.resourceUrl) !== normalizedUrl(resource.resource)) {
        throw new PlinthwayError('AUTH_FAILED', 'Enterprise authorization resource did not match');
      }
      const identity = await options.store.get(
        enterpriseIdentityCredentialKey(options.managedProfile),
      );
      if (identity?.type !== 'mcp-identity') {
        throw new PlinthwayError('AUTH_FAILED', 'Enterprise identity login is required', {
          serverId: options.serverId,
        });
      }
      registerRedactionSecret(identity.assertion);
      validateJwtClaims(identity.assertion, {
        issuer: options.profile.issuer,
        audience: options.profile.clientId,
        now: Math.floor((options.now ?? Date.now)() / 1_000),
      });
      let idpClientSecret: string | undefined;
      if (options.profile.clientCredential !== undefined) {
        const credential = await options.store.get(options.profile.clientCredential.id);
        if (credential?.type !== 'api-key') {
          throw new PlinthwayError(
            'AUTH_FAILED',
            'Managed identity-provider credential is unavailable',
          );
        }
        idpClientSecret = credential.secret;
        registerRedactionSecret(credential.secret);
      }
      const scopes = unionScopes(resource.scopes, context.scope);
      const result = await discoverAndRequestJwtAuthGrant({
        idpUrl: options.profile.issuer,
        audience: resource.authorizationServer,
        resource: resource.resource,
        idToken: identity.assertion,
        clientId: options.profile.clientId,
        ...(idpClientSecret === undefined ? {} : { clientSecret: idpClientSecret }),
        ...(scopes.length === 0 ? {} : { scope: scopes.join(' ') }),
        fetchFn: context.fetchFn,
      });
      validateJwtAuthorizationGrant(result.jwtAuthGrant, {
        issuer: options.profile.issuer,
        audience: resource.authorizationServer,
        resource: resource.resource,
        scopes,
        now: Math.floor((options.now ?? Date.now)() / 1_000),
      });
      registerRedactionSecret(result.jwtAuthGrant);
      return result.jwtAuthGrant;
    },
  });
  return new DurableEnterpriseAuthorizationProvider(
    options,
    delegate,
    resource.authorizationServer,
    resource.resource,
    resource.clientId,
    mcpCredential.secret,
  );
}
