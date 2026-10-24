import { describe, expect, it } from 'vitest';

import { KeyringCredentialStore, KeyringJsonStore, type KeyringEntry } from './keyring-store.js';

describe('KeyringCredentialStore', () => {
  it('saves, reads, and deletes credentials with namespaced accounts', async () => {
    const values = new Map<string, string>();
    const accounts: string[] = [];
    const store = new KeyringCredentialStore((_service, account): KeyringEntry => {
      accounts.push(account);
      return {
        setPassword(value) {
          values.set(account, value);
        },
        getPassword() {
          const value = values.get(account);
          if (value === undefined) throw Object.assign(new Error('missing'), { code: 'NO_ENTRY' });
          return value;
        },
        deletePassword() {
          return values.delete(account);
        },
      };
    });

    await store.set('openai-api-key:default', { type: 'api-key', secret: 'stored-secret' });
    await expect(store.get('openai-api-key:default')).resolves.toEqual({
      type: 'api-key',
      secret: 'stored-secret',
    });
    await store.set('mcp-enterprise-identity:workforce', {
      type: 'mcp-identity',
      assertion: 'signed-id-token',
      issuer: 'https://idp.example.com',
      audience: 'plinthway-desktop',
      subject: 'employee-1',
      expiresAt: 1_700_000_000_000,
    });
    await expect(store.get('mcp-enterprise-identity:workforce')).resolves.toMatchObject({
      type: 'mcp-identity',
      subject: 'employee-1',
    });
    await store.delete('openai-api-key:default');
    await expect(store.get('openai-api-key:default')).resolves.toBeNull();
    expect(new Set(accounts)).toEqual(
      new Set(['openai-api-key:default', 'mcp-enterprise-identity:workforce']),
    );
  });

  it('migrates a legacy credential on read and deletes both service names on logout', async () => {
    const values = new Map<string, string>([
      [
        'local-agent-harness:openai-api-key:default',
        JSON.stringify({ type: 'api-key', secret: 'legacy-secret' }),
      ],
    ]);
    const store = new KeyringCredentialStore((service, account): KeyringEntry => {
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
    });

    await expect(store.get('openai-api-key:default')).resolves.toMatchObject({
      secret: 'legacy-secret',
    });
    expect(values.get('plinthway:openai-api-key:default')).toContain('legacy-secret');

    await store.delete('openai-api-key:default');
    expect(values.has('plinthway:openai-api-key:default')).toBe(false);
    expect(values.has('local-agent-harness:openai-api-key:default')).toBe(false);
  });

  it('uses the new keyring service before any legacy value', async () => {
    const values = new Map<string, string>([
      ['plinthway:account', JSON.stringify({ value: 'new' })],
      ['local-agent-harness:account', JSON.stringify({ value: 'legacy' })],
    ]);
    const store = new KeyringJsonStore<{ value: string }>({
      service: 'plinthway',
      legacyServices: ['local-agent-harness'],
      parse(value) {
        return value as { value: string };
      },
      entryFactory(service, account) {
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
    });

    await expect(store.get('account')).resolves.toEqual({ value: 'new' });
  });
});
