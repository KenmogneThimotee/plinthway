import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '@plinthway/config';

import { PlinthwayError, registerRedactionSecret } from '@plinthway/shared';

import { KeyringJsonStore, type KeyringEntryFactory } from '../keyring-store.js';
import {
  CHATGPT_DIRECT_SCOPE,
  type ChatGptAccounts,
  type ChatGptConnectionSummary,
  type ChatGptLoginOptions,
  type ChatGptModel,
  type ChatGptOAuthFlow,
  type ChatGptTokenSet,
} from './contracts.js';
import { NativeChatGptOAuth } from './oauth.js';
import { ChatGptMetadataStore } from './store.js';

function parseTokens(value: unknown): ChatGptTokenSet {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('clientId' in value) ||
    typeof value.clientId !== 'string' ||
    value.clientId.length === 0 ||
    !('accessToken' in value) ||
    typeof value.accessToken !== 'string' ||
    value.accessToken.length === 0 ||
    !('refreshToken' in value) ||
    typeof value.refreshToken !== 'string' ||
    value.refreshToken.length === 0 ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    !('scope' in value) ||
    !Array.isArray(value.scope) ||
    !value.scope.every((scope): scope is string => typeof scope === 'string') ||
    !('identity' in value) ||
    typeof value.identity !== 'object' ||
    value.identity === null ||
    !('subject' in value.identity) ||
    typeof value.identity.subject !== 'string' ||
    value.identity.subject.length === 0 ||
    ('email' in value.identity &&
      value.identity.email !== undefined &&
      typeof value.identity.email !== 'string') ||
    ('displayName' in value.identity &&
      value.identity.displayName !== undefined &&
      typeof value.identity.displayName !== 'string') ||
    ('idToken' in value && value.idToken !== undefined && typeof value.idToken !== 'string')
  )
    throw new TypeError('Invalid ChatGPT token record');
  return value as ChatGptTokenSet;
}

function modelList(value: unknown): readonly ChatGptModel[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('models' in value) ||
    !Array.isArray(value.models)
  ) {
    throw new PlinthwayError('PROVIDER_ERROR', 'OpenAI returned an invalid model list');
  }
  const models: readonly unknown[] = value.models;
  return models.flatMap((entry): ChatGptModel[] => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('slug' in entry) ||
      typeof entry.slug !== 'string' ||
      !('visibility' in entry) ||
      entry.visibility !== 'list'
    )
      return [];
    const name =
      'display_name' in entry && typeof entry.display_name === 'string'
        ? entry.display_name
        : entry.slug;
    return [{ id: entry.slug, name }];
  });
}

export interface ChatGptAccountServiceOptions {
  readonly accountsFile: string;
  readonly hostFile: string;
  readonly entryFactory?: KeyringEntryFactory;
  readonly oauth?: ChatGptOAuthFlow;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly modelCacheFile?: string;
}

export class ChatGptAccountService implements ChatGptAccounts {
  readonly #metadata: ChatGptMetadataStore;
  readonly #tokens: KeyringJsonStore<ChatGptTokenSet>;
  readonly #oauth: ChatGptOAuthFlow;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #modelCacheFile: string | undefined;
  readonly #refreshing = new Map<string, Promise<ChatGptTokenSet>>();
  readonly #redactions = new Map<string, readonly (() => void)[]>();

  constructor(options: ChatGptAccountServiceOptions) {
    this.#metadata = new ChatGptMetadataStore(options.accountsFile, options.hostFile);
    this.#tokens = new KeyringJsonStore({
      service: 'plinthway-chatgpt',
      legacyServices: ['local-agent-harness-chatgpt'],
      parse: parseTokens,
      ...(options.entryFactory === undefined ? {} : { entryFactory: options.entryFactory }),
    });
    this.#oauth =
      options.oauth ??
      new NativeChatGptOAuth(options.fetch === undefined ? {} : { fetch: options.fetch });
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#modelCacheFile = options.modelCacheFile;
  }

  async signIn(options: ChatGptLoginOptions): Promise<ChatGptConnectionSummary> {
    const current = await this.#metadata.read();
    const selected =
      options.connectionId === undefined
        ? undefined
        : current.find(({ id }) => id === options.connectionId);
    if (options.connectionId !== undefined && selected === undefined) {
      throw new PlinthwayError('AUTH_FAILED', 'The selected ChatGPT account is not registered');
    }
    const retained =
      selected === undefined ? null : await this.#tokens.get(`tokens:${selected.id}`);
    const hostId = await this.#metadata.hostId(this.#randomId);
    const tokens = await this.#oauth.signIn({
      ...options,
      hostId,
      ...(selected === undefined
        ? {}
        : {
            registration: {
              clientId: selected.clientId,
              ...(retained?.idToken === undefined ? {} : { idToken: retained.idToken }),
              ...(selected.email === undefined ? {} : { email: selected.email }),
            },
          }),
    });
    if (!tokens.scope.includes(CHATGPT_DIRECT_SCOPE)) {
      throw new PlinthwayError('AUTH_FAILED', 'ChatGPT plan sharing was not granted');
    }
    if (selected !== undefined && selected.clientId !== tokens.clientId) {
      throw new PlinthwayError('AUTH_FAILED', 'The selected ChatGPT registration did not match');
    }
    if (selected !== undefined && selected.subject !== tokens.identity.subject) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'The authorized ChatGPT account does not match the selected account',
      );
    }
    const id = selected?.id ?? this.#randomId();
    this.#registerTokens(id, tokens);
    const now = this.#now();
    const summary: ChatGptConnectionSummary = {
      id,
      clientId: tokens.clientId,
      subject: tokens.identity.subject,
      ...(tokens.identity.email === undefined ? {} : { email: tokens.identity.email }),
      ...(tokens.identity.displayName === undefined
        ? {}
        : { displayName: tokens.identity.displayName }),
      status: 'connected',
      sharing: true,
      createdAt: selected?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#tokens.set(`pending:${id}`, tokens);
    await this.#tokens.set(`tokens:${id}`, tokens);
    await this.#tokens.delete(`pending:${id}`);
    await this.#metadata.update((connections) => [
      ...connections.filter((connection) => connection.id !== id),
      summary,
    ]);
    return summary;
  }

  #registerTokens(connectionId: string, tokens: ChatGptTokenSet): void {
    const next = [tokens.accessToken, tokens.refreshToken, tokens.idToken]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .map((value) => registerRedactionSecret(value));
    for (const dispose of this.#redactions.get(connectionId) ?? []) dispose();
    this.#redactions.set(connectionId, next);
  }

  async listConnections(): Promise<readonly ChatGptConnectionSummary[]> {
    return this.#metadata.read();
  }

  async #loadTokens(connectionId: string): Promise<ChatGptTokenSet> {
    const pending = await this.#tokens.get(`pending:${connectionId}`);
    if (pending !== null) {
      this.#registerTokens(connectionId, pending);
      await this.#tokens.set(`tokens:${connectionId}`, pending);
      await this.#tokens.delete(`pending:${connectionId}`);
      return pending;
    }
    const tokens = await this.#tokens.get(`tokens:${connectionId}`);
    if (tokens === null)
      throw new PlinthwayError('AUTH_FAILED', 'This ChatGPT account needs to be connected again');
    this.#registerTokens(connectionId, tokens);
    return tokens;
  }

  async #freshTokens(connectionId: string, signal?: AbortSignal): Promise<ChatGptTokenSet> {
    const tokens = await this.#loadTokens(connectionId);
    if (tokens.expiresAt > this.#now() + 60_000) return tokens;
    const active = this.#refreshing.get(connectionId);
    if (active !== undefined) return active;
    const refresh = (async () => {
      try {
        return await this.#metadata.exclusive(async () => {
          const current = await this.#loadTokens(connectionId);
          if (current.expiresAt > this.#now() + 60_000) return current;
          const rotated = await this.#oauth.refresh(current, signal);
          if (
            rotated.identity.subject !== current.identity.subject ||
            !rotated.scope.includes(CHATGPT_DIRECT_SCOPE)
          ) {
            throw new PlinthwayError(
              'AUTH_FAILED',
              'Refreshed ChatGPT credentials failed identity or sharing validation',
            );
          }
          await this.#tokens.set(`pending:${connectionId}`, rotated);
          await this.#tokens.set(`tokens:${connectionId}`, rotated);
          await this.#tokens.delete(`pending:${connectionId}`);
          this.#registerTokens(connectionId, rotated);
          return rotated;
        });
      } catch (error) {
        const terminal =
          error instanceof PlinthwayError &&
          (error.details.providerError === 'invalid_grant' ||
            error.details.providerError === 'invalid_token');
        if (terminal) {
          await this.#metadata.update((connections) =>
            connections.map((connection) =>
              connection.id === connectionId
                ? { ...connection, status: 'reauthentication-required', updatedAt: this.#now() }
                : connection,
            ),
          );
        }
        throw error;
      } finally {
        this.#refreshing.delete(connectionId);
      }
    })();
    this.#refreshing.set(connectionId, refresh);
    return refresh;
  }

  async withAccessToken<T>(
    connectionId: string,
    operation: (accessToken: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (
      !(await this.#metadata.read()).some(
        ({ id, status }) => id === connectionId && status === 'connected',
      )
    ) {
      throw new PlinthwayError('AUTH_FAILED', 'This ChatGPT account is not connected');
    }
    return operation((await this.#freshTokens(connectionId, signal)).accessToken);
  }

  async listModels(connectionId: string, signal?: AbortSignal): Promise<readonly ChatGptModel[]> {
    return this.withAccessToken(
      connectionId,
      async (accessToken) => {
        const response = await this.#fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok)
          throw new PlinthwayError('PROVIDER_ERROR', 'Could not load ChatGPT models', {
            status: response.status,
          });
        const models = modelList(await response.json());
        if (this.#modelCacheFile !== undefined) {
          await atomicWriteFile(
            this.#modelCacheFile,
            `${JSON.stringify({ schemaVersion: 1, connectionId, fetchedAt: this.#now(), models }, null, 2)}\n`,
          );
        }
        return models;
      },
      signal,
    );
  }

  async disconnect(connectionId: string): Promise<{ readonly revocationConfirmed: boolean }> {
    const registered = (await this.#metadata.read()).some(({ id }) => id === connectionId);
    if (!registered)
      throw new PlinthwayError('AUTH_FAILED', 'The selected ChatGPT account is not registered');
    const tokens = await this.#tokens.get(`tokens:${connectionId}`);
    const revocationConfirmed = tokens === null ? true : await this.#oauth.revoke(tokens);
    await this.#tokens.delete(`tokens:${connectionId}`);
    await this.#tokens.delete(`pending:${connectionId}`);
    for (const dispose of this.#redactions.get(connectionId) ?? []) dispose();
    this.#redactions.delete(connectionId);
    await this.#metadata.update((connections) =>
      connections.map((connection) =>
        connection.id === connectionId
          ? { ...connection, status: 'disconnected', updatedAt: this.#now() }
          : connection,
      ),
    );
    return { revocationConfirmed };
  }
}
