import { randomBytes } from 'node:crypto';

import type { CredentialStore } from '@plinthway/auth';
import {
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  InsecureTokenEndpointError,
  OAuthClientFlowError,
  OAuthError,
  OAuthErrorCode,
  auth,
  computeScopeUnion,
  isStrictScopeSuperset,
} from '@modelcontextprotocol/client';

import { canonicalJson, PlinthwayError, sha256, type JsonValue } from '@plinthway/shared';

import {
  startOAuthLoopbackCallback,
  type OAuthLoopbackCallback,
  type OAuthLoopbackOptions,
} from './oauth-loopback.js';

interface PersistedOAuthState {
  readonly version: 1;
  readonly latestIssuer?: string;
  readonly tokens: Readonly<Record<string, JsonValue>>;
  readonly clients: Readonly<Record<string, JsonValue>>;
  readonly codeVerifier?: string;
  readonly oauthState?: string;
  readonly discovery?: JsonValue;
}

export interface PlinthwayOAuthClientProviderOptions {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly clientMetadataUrl?: string;
  readonly scopes: readonly string[];
  readonly store: CredentialStore;
  readonly redirectToAuthorization: (authorizationUrl: URL) => void | Promise<void>;
  readonly deferAuthorizationRedirect?: boolean;
}

function externalJsonValue(value: unknown): unknown {
  if (value instanceof URL) return value.href;
  if (Array.isArray(value)) return value.map(externalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, externalJsonValue(entry)]),
    );
  }
  return value;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(externalJsonValue(value))) as JsonValue;
}

function emptyState(): PersistedOAuthState {
  return { version: 1, tokens: {}, clients: {} };
}

const KNOWN_OAUTH_ERROR_CODES = new Set<string>(Object.values(OAuthErrorCode));

function normalizeOAuthFailure(serverId: string, error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  if (error instanceof InsecureTokenEndpointError) {
    return new PlinthwayError(
      'AUTH_FAILED',
      `MCP OAuth token endpoint for ${serverId} is not permitted; use HTTPS or a verified loopback address`,
      { serverId, reason: 'insecure_token_endpoint' },
      { cause: error },
    );
  }
  if (error instanceof OAuthError) {
    const oauthCode = KNOWN_OAUTH_ERROR_CODES.has(error.code) ? error.code : 'unknown_oauth_error';
    return new PlinthwayError(
      'AUTH_FAILED',
      `MCP OAuth authorization failed for ${serverId}; check the server authorization settings and try again`,
      { serverId, reason: 'oauth_error', oauthCode },
      { cause: error },
    );
  }
  if (error instanceof OAuthClientFlowError) {
    return new PlinthwayError(
      'AUTH_FAILED',
      `MCP OAuth client flow failed for ${serverId}; check the server authorization settings and try again`,
      { serverId, reason: 'oauth_client_flow' },
      { cause: error },
    );
  }
  if (error instanceof Error && /code challenge method S256/iu.test(error.message)) {
    return new PlinthwayError(
      'AUTH_FAILED',
      `MCP OAuth server ${serverId} does not support required PKCE S256`,
      { serverId, reason: 'pkce_s256_required' },
      { cause: error },
    );
  }
  return new PlinthwayError(
    'AUTH_FAILED',
    `MCP OAuth authorization failed for ${serverId}; check the server authorization settings and try again`,
    { serverId, reason: 'oauth_request_failed' },
    { cause: error },
  );
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function parseState(value: Readonly<Record<string, JsonValue>>): PersistedOAuthState {
  if (value.version !== 1)
    throw new PlinthwayError('AUTH_FAILED', 'Stored MCP OAuth state is invalid');
  const tokens = value.tokens;
  const clients = value.clients;
  if (!isJsonObject(tokens) || !isJsonObject(clients)) {
    throw new PlinthwayError('AUTH_FAILED', 'Stored MCP OAuth state is invalid');
  }
  return {
    version: 1,
    tokens,
    clients,
    ...(typeof value.latestIssuer === 'string' ? { latestIssuer: value.latestIssuer } : {}),
    ...(typeof value.codeVerifier === 'string' ? { codeVerifier: value.codeVerifier } : {}),
    ...(typeof value.oauthState === 'string' ? { oauthState: value.oauthState } : {}),
    ...(value.discovery === undefined ? {} : { discovery: value.discovery }),
  };
}

export class PlinthwayOAuthClientProvider implements OAuthClientProvider {
  readonly #serverId: string;
  readonly #serverUrl: URL;
  readonly #store: CredentialStore;
  readonly #storeKey: string;
  readonly #configuredClientId: string | undefined;
  readonly #configuredClientSecret: string | undefined;
  readonly #redirect: (authorizationUrl: URL) => void | Promise<void>;
  readonly #deferAuthorizationRedirect: boolean;
  #lastAuthorizationUrl: URL | undefined;
  #authorizationRedirectDispatched = false;
  redirectUrl: URL;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;

  constructor(options: PlinthwayOAuthClientProviderOptions) {
    this.#serverId = options.serverId;
    this.#serverUrl = new URL(options.serverUrl);
    this.#store = options.store;
    this.#storeKey = `mcp-oauth:${sha256(this.#serverUrl.href)}`;
    this.#configuredClientId = options.clientMetadataUrl ?? options.clientId;
    this.#configuredClientSecret = options.clientSecret;
    this.#redirect = options.redirectToAuthorization;
    this.#deferAuthorizationRedirect = options.deferAuthorizationRedirect === true;
    this.redirectUrl = new URL(options.redirectUrl);
    if (options.clientMetadataUrl !== undefined) {
      this.clientMetadataUrl = options.clientMetadataUrl;
    }
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl.href],
      client_name: 'Plinthway',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: options.scopes.join(' '),
    };
  }

  async #read(): Promise<PersistedOAuthState> {
    const credential = await this.#store.get(this.#storeKey);
    if (credential === null) return emptyState();
    if (credential.type !== 'mcp-oauth') {
      throw new PlinthwayError('AUTH_FAILED', 'Stored MCP OAuth credential has the wrong type', {
        serverId: this.#serverId,
      });
    }
    return parseState(credential.state);
  }

  async #write(state: PersistedOAuthState): Promise<void> {
    await this.#store.set(this.#storeKey, {
      type: 'mcp-oauth',
      state: asJson(state) as Readonly<Record<string, JsonValue>>,
    });
  }

  async state(): Promise<string> {
    const current = await this.#read();
    if (current.oauthState !== undefined) return current.oauthState;
    const oauthState = randomBytes(32).toString('base64url');
    await this.#write({ ...current, oauthState });
    return oauthState;
  }

  get lastAuthorizationUrl(): URL | undefined {
    return this.#lastAuthorizationUrl;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this.#configuredClientId !== undefined) {
      return {
        client_id: this.#configuredClientId,
        ...(this.#configuredClientSecret === undefined
          ? {}
          : { client_secret: this.#configuredClientSecret }),
        ...(context === undefined ? {} : { issuer: context.issuer }),
      };
    }
    if (context === undefined) return undefined;
    const value = (await this.#read()).clients[context.issuer];
    return value === undefined ? undefined : (value as unknown as StoredOAuthClientInformation);
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = context?.issuer ?? clientInformation.issuer;
    if (issuer === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'OAuth client registration is missing its issuer');
    }
    const current = await this.#read();
    await this.#write({
      ...current,
      clients: { ...current.clients, [issuer]: asJson({ ...clientInformation, issuer }) },
    });
  }

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const current = await this.#read();
    const issuer = context?.issuer ?? current.latestIssuer;
    if (issuer === undefined) return undefined;
    const value = current.tokens[issuer];
    return value === undefined ? undefined : (value as unknown as StoredOAuthTokens);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = context?.issuer ?? tokens.issuer;
    if (issuer === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'OAuth tokens are missing their issuer');
    }
    const current = await this.#read();
    await this.#write({
      ...current,
      latestIssuer: issuer,
      tokens: { ...current.tokens, [issuer]: asJson({ ...tokens, issuer }) },
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    this.#lastAuthorizationUrl = new URL(authorizationUrl);
    this.#authorizationRedirectDispatched = false;
    if (this.#deferAuthorizationRedirect) return;
    this.#authorizationRedirectDispatched = true;
    return this.#redirect(authorizationUrl);
  }

  async dispatchAuthorizationRedirect(): Promise<void> {
    if (this.#lastAuthorizationUrl === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'OAuth requested a redirect without a URL', {
        serverId: this.#serverId,
      });
    }
    if (this.#authorizationRedirectDispatched) return;
    this.#authorizationRedirectDispatched = true;
    await this.#redirect(this.#lastAuthorizationUrl);
  }

  setRedirectUrl(redirectUrl: URL): void {
    this.redirectUrl = new URL(redirectUrl);
    this.clientMetadata.redirect_uris = [this.redirectUrl.href];
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.#write({ ...(await this.#read()), codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.#read()).codeVerifier;
    if (verifier === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'The OAuth PKCE verifier is missing', {
        serverId: this.#serverId,
      });
    }
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.#write({ ...(await this.#read()), discovery: asJson(discovery) });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const discovery = (await this.#read()).discovery;
    return discovery === undefined ? undefined : (discovery as unknown as OAuthDiscoveryState);
  }

  validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (resource === undefined) return Promise.resolve(undefined);
    const expected = new URL(serverUrl);
    const candidate = new URL(resource);
    const sameResourcePath =
      candidate.pathname === '/' ||
      expected.pathname.replace(/\/$/u, '') === candidate.pathname.replace(/\/$/u, '');
    if (expected.origin !== candidate.origin || !sameResourcePath) {
      return Promise.reject(
        new PlinthwayError('AUTH_FAILED', 'OAuth resource does not match the MCP server', {
          serverId: this.#serverId,
        }),
      );
    }
    if (candidate.href !== resource) {
      // The SDK serializes provider-approved resources through URL.href. Preserve a
      // pathless RFC 8707 identifier exactly as published instead of appending `/`.
      Object.defineProperty(candidate, 'href', {
        configurable: true,
        enumerable: true,
        value: resource,
      });
    }
    return Promise.resolve(candidate);
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all') {
      await this.#store.delete(this.#storeKey);
      return;
    }
    const current = await this.#read();
    if (scope === 'tokens') {
      await this.#write({
        version: 1,
        tokens: {},
        clients: current.clients,
        ...(current.codeVerifier === undefined ? {} : { codeVerifier: current.codeVerifier }),
        ...(current.oauthState === undefined ? {} : { oauthState: current.oauthState }),
        ...(current.discovery === undefined ? {} : { discovery: current.discovery }),
      });
    } else if (scope === 'client') {
      await this.#write({ ...current, clients: {} });
    } else if (scope === 'verifier') {
      await this.#write({
        version: 1,
        tokens: current.tokens,
        clients: current.clients,
        ...(current.latestIssuer === undefined ? {} : { latestIssuer: current.latestIssuer }),
        ...(current.discovery === undefined ? {} : { discovery: current.discovery }),
      });
    } else {
      await this.#write({
        version: 1,
        tokens: current.tokens,
        clients: current.clients,
        ...(current.latestIssuer === undefined ? {} : { latestIssuer: current.latestIssuer }),
        ...(current.codeVerifier === undefined ? {} : { codeVerifier: current.codeVerifier }),
        ...(current.oauthState === undefined ? {} : { oauthState: current.oauthState }),
      });
    }
  }
}

interface OAuthRegistration {
  readonly serverUrl: URL;
  readonly provider: PlinthwayOAuthClientProvider;
  readonly scopes: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly automaticLoopback: boolean;
}

export interface McpOAuthRegistrationOptions {
  readonly automaticLoopback?: boolean;
}

export interface McpOAuthControllerOptions {
  readonly startLoopback?: (options: OAuthLoopbackOptions) => Promise<OAuthLoopbackCallback>;
}

export type McpAuthorizationHandler = (
  input?: McpOAuthAuthorizationInput,
) => Promise<McpOAuthAuthorizationResult>;

export interface McpOAuthAuthorizationInput {
  readonly code?: string;
  readonly state?: string;
  readonly issuer?: string;
  readonly requiredScope?: string;
  readonly resourceMetadataUrl?: string;
}

export interface McpOAuthAuthorizationResult {
  readonly state: 'authorized' | 'redirect';
  readonly authorizationUrl?: string;
  readonly waitForCompletion?: (signal?: AbortSignal) => Promise<void>;
}

export class McpOAuthController {
  readonly #registrations = new Map<string, OAuthRegistration>();
  readonly #handlers = new Map<string, McpAuthorizationHandler>();
  readonly #startLoopback: (options: OAuthLoopbackOptions) => Promise<OAuthLoopbackCallback>;

  constructor(options: McpOAuthControllerOptions = {}) {
    this.#startLoopback = options.startLoopback ?? startOAuthLoopbackCallback;
  }

  registerHandler(serverId: string, handler: McpAuthorizationHandler): void {
    this.#registrations.delete(serverId);
    this.#handlers.set(serverId, handler);
  }

  register(
    serverId: string,
    serverUrl: string,
    provider: PlinthwayOAuthClientProvider,
    scopes: readonly string[],
    fetch?: typeof globalThis.fetch,
    options: McpOAuthRegistrationOptions = {},
  ): void {
    this.#handlers.delete(serverId);
    this.#registrations.set(serverId, {
      serverUrl: new URL(serverUrl),
      provider,
      scopes: [...scopes],
      automaticLoopback: options.automaticLoopback === true,
      ...(fetch === undefined ? {} : { fetch }),
    });
  }

  async authorize(
    serverId: string,
    input: McpOAuthAuthorizationInput = {},
  ): Promise<McpOAuthAuthorizationResult> {
    const handler = this.#handlers.get(serverId);
    if (handler !== undefined) return handler(input);
    const registration = this.#registrations.get(serverId);
    if (registration === undefined) {
      throw new PlinthwayError('AUTH_FAILED', `MCP OAuth is not configured for ${serverId}`, {
        serverId,
      });
    }
    const current = await registration.provider.tokens();
    if (input.code === undefined && current !== undefined) {
      // A rejected token can coincide with a protected resource moving to a
      // different authorization server. Re-discover before reauthorization so
      // issuer-bound client registrations and tokens cannot cross that boundary.
      await registration.provider.invalidateCredentials('discovery');
    }
    if (input.code !== undefined) {
      if (input.state === undefined || input.state !== (await registration.provider.state())) {
        throw new PlinthwayError('AUTH_FAILED', 'OAuth callback state did not match', { serverId });
      }
    }
    let loopback: OAuthLoopbackCallback | undefined;
    if (input.code === undefined && registration.automaticLoopback) {
      loopback = await this.#startLoopback({ expectedState: await registration.provider.state() });
      try {
        registration.provider.setRedirectUrl(loopback.redirectUrl);
        await registration.provider.invalidateCredentials('client');
      } catch (error) {
        await loopback.close().catch(() => undefined);
        throw error;
      }
    }
    const requestedScope = computeScopeUnion(
      registration.scopes.join(' '),
      current?.scope,
      input.requiredScope,
    );
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(registration.provider, {
        serverUrl: registration.serverUrl,
        ...(input.code === undefined ? {} : { authorizationCode: input.code }),
        ...(input.issuer === undefined ? {} : { iss: input.issuer }),
        ...(input.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: new URL(input.resourceMetadataUrl) }),
        ...(requestedScope === undefined ? {} : { scope: requestedScope }),
        ...(registration.fetch === undefined ? {} : { fetchFn: registration.fetch }),
        ...(input.requiredScope !== undefined &&
        isStrictScopeSuperset(requestedScope, current?.scope)
          ? { forceReauthorization: true }
          : {}),
      });
    } catch (error) {
      await loopback?.close().catch(() => undefined);
      throw normalizeOAuthFailure(serverId, error);
    }
    if (result === 'AUTHORIZED') {
      await loopback?.close().catch(() => undefined);
      await registration.provider.invalidateCredentials('verifier');
      return { state: 'authorized' };
    }
    const authorizationUrl = registration.provider.lastAuthorizationUrl;
    if (authorizationUrl === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'OAuth requested a redirect without a URL', {
        serverId,
      });
    }
    try {
      await registration.provider.dispatchAuthorizationRedirect();
    } catch (error) {
      await loopback?.close().catch(() => undefined);
      throw error;
    }
    if (loopback === undefined) {
      return { state: 'redirect', authorizationUrl: authorizationUrl.href };
    }
    const completion = loopback.result
      .then(async (callback) => {
        const completed = await this.authorize(serverId, {
          code: callback.code,
          state: callback.state,
          ...(callback.issuer === undefined ? {} : { issuer: callback.issuer }),
          ...(input.resourceMetadataUrl === undefined
            ? {}
            : { resourceMetadataUrl: input.resourceMetadataUrl }),
          ...(input.requiredScope === undefined ? {} : { requiredScope: input.requiredScope }),
        });
        if (completed.state !== 'authorized') {
          throw new PlinthwayError('AUTH_FAILED', 'OAuth callback did not complete authorization', {
            serverId,
          });
        }
      })
      .finally(() => loopback.close());
    void completion.catch(() => undefined);
    return {
      state: 'redirect',
      authorizationUrl: authorizationUrl.href,
      waitForCompletion: (signal) => {
        if (signal?.aborted === true) {
          void loopback.close();
          return Promise.reject(
            new PlinthwayError('CANCELLED', 'OAuth authorization was cancelled'),
          );
        }
        if (signal === undefined) return completion;
        return new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            void loopback.close();
            reject(new PlinthwayError('CANCELLED', 'OAuth authorization was cancelled'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void completion.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
      },
    };
  }
}
