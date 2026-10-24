/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { redact } from '@plinthway/shared';

import type { KeyringEntry, KeyringEntryFactory } from '../keyring-store.js';
import { ChatGptAccountService } from './service.js';
import type { ChatGptOAuthFlow, ChatGptTokenSet } from './contracts.js';

function tokenSet(subject: string, suffix = 'one'): ChatGptTokenSet {
  return {
    clientId: 'oaiapp-test',
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    idToken: `id-${suffix}`,
    expiresAt: Date.now() + 3_600_000,
    scope: [
      'openid',
      'profile',
      'email',
      'offline_access',
      'resource.invoke',
      'chatgpt.tokens.use.direct',
    ],
    identity: { subject, email: `${subject}@example.com`, displayName: subject },
  };
}

function memoryKeyring(): { factory: KeyringEntryFactory; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    factory(service, account): KeyringEntry {
      const key = `${service}:${account}`;
      return {
        setPassword(value) {
          values.set(key, value);
        },
        getPassword() {
          return values.get(key) ?? null;
        },
        deletePassword() {
          return values.delete(key);
        },
      };
    },
  };
}

async function plinthwayPaths() {
  const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-chatgpt-auth-'));
  return {
    accountsFile: path.join(directory, 'accounts.json'),
    hostFile: path.join(directory, 'host.json'),
  };
}

describe('ChatGptAccountService', () => {
  it('adopts tokens from the legacy ChatGPT keyring service and removes both copies', async () => {
    const paths = await plinthwayPaths();
    const keyring = memoryKeyring();
    const id = 'legacy-connection';
    const tokens = tokenSet('legacy-user');
    await writeFile(
      paths.accountsFile,
      `${JSON.stringify({
        schemaVersion: 1,
        connections: [
          {
            id,
            clientId: tokens.clientId,
            subject: tokens.identity.subject,
            status: 'connected',
            sharing: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })}\n`,
    );
    keyring.values.set(`local-agent-harness-chatgpt:tokens:${id}`, JSON.stringify(tokens));
    const oauth: ChatGptOAuthFlow = {
      signIn: async () => tokens,
      refresh: async (current) => current,
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({ ...paths, entryFactory: keyring.factory, oauth });

    await expect(service.withAccessToken(id, async (token) => token)).resolves.toBe('access-one');
    expect(keyring.values.get(`plinthway-chatgpt:tokens:${id}`)).toContain('access-one');

    await service.disconnect(id);
    expect(keyring.values.has(`plinthway-chatgpt:tokens:${id}`)).toBe(false);
    expect(keyring.values.has(`local-agent-harness-chatgpt:tokens:${id}`)).toBe(false);
  });

  it('uses a UUID URN as the host identifier for a new installation', async () => {
    const paths = await plinthwayPaths();
    let hostId: string | undefined;
    const oauth: ChatGptOAuthFlow = {
      signIn: async (options) => {
        hostId = options.hostId;
        return tokenSet('user');
      },
      refresh: async (tokens) => tokens,
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({
      ...paths,
      entryFactory: memoryKeyring().factory,
      oauth,
      randomId: () => '145cbdd7-e8eb-42f8-9dd8-ec1836811eb8',
    });

    await service.signIn({ openBrowser: false });

    expect(hostId).toBe('urn:uuid:145cbdd7-e8eb-42f8-9dd8-ec1836811eb8');
    await expect(readFile(paths.hostFile, 'utf8')).resolves.toContain(
      'urn:uuid:145cbdd7-e8eb-42f8-9dd8-ec1836811eb8',
    );
  });

  it('upgrades a persisted bare UUID before starting authorization', async () => {
    const paths = await plinthwayPaths();
    await writeFile(
      paths.hostFile,
      `${JSON.stringify({
        schemaVersion: 1,
        hostId: '145cbdd7-e8eb-42f8-9dd8-ec1836811eb8',
      })}\n`,
    );
    let hostId: string | undefined;
    const oauth: ChatGptOAuthFlow = {
      signIn: async (options) => {
        hostId = options.hostId;
        return tokenSet('user');
      },
      refresh: async (tokens) => tokens,
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({
      ...paths,
      entryFactory: memoryKeyring().factory,
      oauth,
    });

    await service.signIn({ openBrowser: false });

    expect(hostId).toBe('urn:uuid:145cbdd7-e8eb-42f8-9dd8-ec1836811eb8');
    await expect(readFile(paths.hostFile, 'utf8')).resolves.toContain(
      'urn:uuid:145cbdd7-e8eb-42f8-9dd8-ec1836811eb8',
    );
  });

  it('stores account metadata separately from keyring-only token values', async () => {
    const paths = await plinthwayPaths();
    const keyring = memoryKeyring();
    const oauth: ChatGptOAuthFlow = {
      signIn: async () => tokenSet('user'),
      refresh: async () => tokenSet('user', 'refreshed'),
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({ ...paths, entryFactory: keyring.factory, oauth });

    await expect(service.signIn({ openBrowser: false, callbackPort: 1455 })).resolves.toMatchObject(
      {
        status: 'connected',
        sharing: true,
        email: 'user@example.com',
      },
    );
    const [connection] = await service.listConnections();
    expect(connection).toMatchObject({
      clientId: 'oaiapp-test',
      email: 'user@example.com',
      subject: 'user',
    });

    const metadata = await import('node:fs/promises').then(({ readFile }) =>
      readFile(paths.accountsFile, 'utf8'),
    );
    expect(metadata).not.toContain('access-one');
    expect(metadata).not.toContain('refresh-one');
    expect(metadata).not.toContain('id-one');
    expect([...keyring.values.values()].join('\n')).toContain('access-one');
    expect(redact('access-one refresh-one id-one')).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });

  it('preserves an existing connection when a returning login has another subject', async () => {
    const paths = await plinthwayPaths();
    const keyring = memoryKeyring();
    let next = tokenSet('first');
    const signInOptions: Parameters<ChatGptOAuthFlow['signIn']>[0][] = [];
    const oauth: ChatGptOAuthFlow = {
      signIn: async (options) => {
        signInOptions.push(options);
        return next;
      },
      refresh: async (tokens) => tokens,
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({ ...paths, entryFactory: keyring.factory, oauth });
    const original = await service.signIn({ openBrowser: false });
    next = tokenSet('second');

    await expect(
      service.signIn({ openBrowser: false, connectionId: original.id }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(signInOptions[0]?.registration).toBeUndefined();
    expect(signInOptions[1]?.registration).toEqual({
      clientId: 'oaiapp-test',
      idToken: 'id-one',
      email: 'first@example.com',
    });
    expect(await service.listConnections()).toEqual([original]);
  });

  it('serializes refresh and makes the rotated token durable before use', async () => {
    const paths = await plinthwayPaths();
    const keyring = memoryKeyring();
    let refreshes = 0;
    const now = 1_000_000;
    const expired = { ...tokenSet('user'), expiresAt: now - 1 };
    const oauth: ChatGptOAuthFlow = {
      signIn: async () => expired,
      refresh: async () => {
        refreshes += 1;
        return { ...tokenSet('user', 'rotated'), expiresAt: now + 3_600_000 };
      },
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({
      ...paths,
      entryFactory: keyring.factory,
      oauth,
      now: () => now,
    });
    const connection = await service.signIn({ openBrowser: false });

    const values = await Promise.all([
      service.withAccessToken(connection.id, async (token) => token),
      service.withAccessToken(connection.id, async (token) => token),
    ]);
    expect(values).toEqual(['access-rotated', 'access-rotated']);
    expect(refreshes).toBe(1);
    expect([...keyring.values.values()].join('\n')).toContain('refresh-rotated');
  });

  it('requires direct ChatGPT plan-sharing consent', async () => {
    const paths = await plinthwayPaths();
    const tokens = tokenSet('user');
    const oauth: ChatGptOAuthFlow = {
      signIn: async () => ({
        ...tokens,
        scope: tokens.scope.filter((scope) => scope !== 'chatgpt.tokens.use.direct'),
      }),
      refresh: async (current) => current,
      revoke: async () => true,
    };
    const service = new ChatGptAccountService({
      ...paths,
      entryFactory: memoryKeyring().factory,
      oauth,
    });

    await expect(service.signIn({ openBrowser: false })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(await service.listConnections()).toEqual([]);
  });

  it('lists account-specific models and rejects redirects at the resource boundary', async () => {
    const paths = await plinthwayPaths();
    const oauth: ChatGptOAuthFlow = {
      signIn: async () => tokenSet('user'),
      refresh: async (current) => current,
      revoke: async () => true,
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const service = new ChatGptAccountService({
      ...paths,
      modelCacheFile: path.join(path.dirname(paths.accountsFile), 'chatgpt-models.json'),
      entryFactory: memoryKeyring().factory,
      oauth,
      fetch: async (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        return Response.json({
          models: [
            { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
            { slug: 'gpt-hidden', display_name: 'GPT Hidden', visibility: 'hidden' },
          ],
        });
      },
    });
    const connection = await service.signIn({ openBrowser: false });

    await expect(service.listModels(connection.id)).resolves.toEqual([
      { id: 'gpt-test', name: 'GPT Test' },
    ]);
    expect(requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/models',
      init: { redirect: 'error' },
    });
    const cache = await import('node:fs/promises').then(({ readFile }) =>
      readFile(path.join(path.dirname(paths.accountsFile), 'chatgpt-models.json'), 'utf8'),
    );
    expect(cache).toContain('gpt-test');
    expect(cache).not.toContain('access-one');
  });
});
