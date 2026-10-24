import type { JsonValue } from '@plinthway/shared';

export type Credential =
  | { readonly type: 'api-key'; readonly secret: string }
  | { readonly type: 'oauth'; readonly accessToken: string; readonly expiresAt: number }
  | { readonly type: 'mcp-oauth'; readonly state: Readonly<Record<string, JsonValue>> }
  | {
      readonly type: 'mcp-identity';
      readonly assertion: string;
      readonly issuer: string;
      readonly audience: string;
      readonly subject: string;
      readonly expiresAt: number;
    }
  | { readonly type: 'none' };

export type CredentialSource = 'environment' | 'keyring' | 'encrypted-file' | 'none';

export interface AuthLoginInput {
  readonly credential: Credential;
  readonly account?: string;
}

export interface AuthStatus {
  readonly available: boolean;
  readonly source: CredentialSource;
}

export interface AuthPlugin {
  readonly id: string;
  readonly providerId: string;
  login(input: AuthLoginInput): Promise<void>;
  logout(account?: string): Promise<void>;
  getCredentials(account?: string): Promise<Credential | null>;
  status(account?: string): Promise<AuthStatus>;
}

export interface CredentialStore {
  readonly source: 'keyring' | 'encrypted-file';
  get(key: string): Promise<Credential | null>;
  set(key: string, credential: Credential): Promise<void>;
  delete(key: string): Promise<void>;
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

export function credentialSecret(credential: Credential): string | undefined {
  if (credential.type === 'api-key') return credential.secret;
  if (credential.type === 'oauth') return credential.accessToken;
  if (credential.type === 'mcp-identity') return credential.assertion;
  if (credential.type === 'mcp-oauth') {
    const latestIssuer = credential.state.latestIssuer;
    const tokens = credential.state.tokens;
    if (typeof latestIssuer === 'string' && isJsonObject(tokens)) {
      const current = tokens[latestIssuer];
      if (isJsonObject(current) && typeof current.access_token === 'string') {
        return current.access_token;
      }
    }
  }
  return undefined;
}

export function parseCredential(value: unknown): Credential {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new TypeError('Invalid stored credential');
  }
  if (value.type === 'none') return { type: 'none' };
  if (
    value.type === 'mcp-oauth' &&
    'state' in value &&
    typeof value.state === 'object' &&
    value.state !== null &&
    !Array.isArray(value.state)
  ) {
    return {
      type: 'mcp-oauth',
      state: value.state as Readonly<Record<string, JsonValue>>,
    };
  }
  if (value.type === 'api-key' && 'secret' in value && typeof value.secret === 'string') {
    return { type: 'api-key', secret: value.secret };
  }
  if (
    value.type === 'mcp-identity' &&
    'assertion' in value &&
    typeof value.assertion === 'string' &&
    'issuer' in value &&
    typeof value.issuer === 'string' &&
    'audience' in value &&
    typeof value.audience === 'string' &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  ) {
    return {
      type: 'mcp-identity',
      assertion: value.assertion,
      issuer: value.issuer,
      audience: value.audience,
      subject: value.subject,
      expiresAt: value.expiresAt,
    };
  }
  if (
    value.type === 'oauth' &&
    'accessToken' in value &&
    typeof value.accessToken === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  ) {
    return { type: 'oauth', accessToken: value.accessToken, expiresAt: value.expiresAt };
  }
  throw new TypeError('Invalid stored credential');
}
