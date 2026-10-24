export const CHATGPT_DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_DIRECT_SCOPE,
]);

export interface ChatGptIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface ChatGptTokenSet {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken?: string;
  readonly expiresAt: number;
  readonly scope: readonly string[];
  readonly identity: ChatGptIdentity;
}

export interface ChatGptConnectionSummary extends ChatGptIdentity {
  readonly id: string;
  readonly clientId: string;
  readonly status: 'connected' | 'disconnected' | 'reauthentication-required';
  readonly sharing: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ChatGptLoginOptions {
  readonly openBrowser?: boolean;
  readonly callbackPort?: number;
  readonly timeoutMs?: number;
  readonly connectionId?: string;
  readonly onAuthorizationUrl?: (url: string) => void;
}

export interface ChatGptModel {
  readonly id: string;
  readonly name: string;
}

export interface ChatGptOAuthFlow {
  signIn(
    options: ChatGptLoginOptions & {
      readonly hostId: string;
      readonly registration?: {
        readonly clientId: string;
        readonly idToken?: string;
        readonly email?: string;
      };
    },
  ): Promise<ChatGptTokenSet>;
  refresh(tokens: ChatGptTokenSet, signal?: AbortSignal): Promise<ChatGptTokenSet>;
  revoke(tokens: ChatGptTokenSet): Promise<boolean>;
}

export interface ChatGptTokenProvider {
  withAccessToken<T>(
    connectionId: string,
    operation: (accessToken: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface ChatGptAccounts extends ChatGptTokenProvider {
  signIn(options: ChatGptLoginOptions): Promise<ChatGptConnectionSummary>;
  listConnections(): Promise<readonly ChatGptConnectionSummary[]>;
  disconnect(connectionId: string): Promise<{ readonly revocationConfirmed: boolean }>;
  listModels(connectionId: string, signal?: AbortSignal): Promise<readonly ChatGptModel[]>;
}
