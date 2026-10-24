import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PlinthwayError, redact } from '@plinthway/shared';

import type { Credential, CredentialStore } from './contracts.js';
import { EncryptedFileCredentialStore } from './encrypted-file-store.js';
import { EnvironmentCredentialStore } from './environment-store.js';
import {
  ApiKeyAuthPlugin,
  AuthService,
  createDefaultAuthService,
  NoneAuthPlugin,
} from './service.js';

class MemoryStore implements CredentialStore {
  readonly source;
  readonly values = new Map<string, Credential>();
  fail = false;

  constructor(source: 'keyring' | 'encrypted-file') {
    this.source = source;
  }

  get(key: string): Promise<Credential | null> {
    if (this.fail) return Promise.reject(new Error(`${this.source} unavailable`));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, credential: Credential): Promise<void> {
    if (this.fail) return Promise.reject(new Error(`${this.source} unavailable`));
    this.values.set(key, credential);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error(`${this.source} unavailable`));
    this.values.delete(key);
    return Promise.resolve();
  }
}

function setup(environment: Record<string, string> = {}) {
  const keyring = new MemoryStore('keyring');
  const encrypted = new MemoryStore('encrypted-file');
  const plugin = new ApiKeyAuthPlugin({
    id: 'openai-api-key',
    providerId: 'openai',
    environmentVariable: 'OPENAI_API_KEY',
    environment: new EnvironmentCredentialStore(environment),
    keyring,
    encryptedFile: encrypted,
  });
  const service = new AuthService([plugin, new NoneAuthPlugin()]);
  return { encrypted, keyring, service };
}

describe('AuthService', () => {
  it('uses environment credentials first without persisting them', async () => {
    const { encrypted, keyring, service } = setup({ OPENAI_API_KEY: 'env-secret' });
    await expect(service.getCredentials('openai-api-key')).resolves.toEqual({
      type: 'api-key',
      secret: 'env-secret',
    });
    expect(keyring.values.size).toBe(0);
    expect(encrypted.values.size).toBe(0);
    await expect(service.status('openai-api-key')).resolves.toEqual({
      available: true,
      source: 'environment',
    });
  });

  it('falls back to the encrypted file when keyring persistence is unavailable', async () => {
    const { encrypted, keyring, service } = setup();
    keyring.fail = true;
    await service.login('openai-api-key', {
      credential: { type: 'api-key', secret: 'fallback-secret' },
    });
    expect(encrypted.values.get('openai-api-key:default')).toEqual({
      type: 'api-key',
      secret: 'fallback-secret',
    });
    await expect(service.status('openai-api-key')).resolves.toEqual({
      available: true,
      source: 'encrypted-file',
    });
  });

  it('prefers a keyring credential over an encrypted-file credential', async () => {
    const { encrypted, keyring, service } = setup();
    keyring.values.set('openai-api-key:default', { type: 'api-key', secret: 'keyring-secret' });
    encrypted.values.set('openai-api-key:default', {
      type: 'api-key',
      secret: 'older-file-secret',
    });
    await expect(service.getCredentials('openai-api-key')).resolves.toEqual({
      type: 'api-key',
      secret: 'keyring-secret',
    });
    await expect(service.status('openai-api-key')).resolves.toEqual({
      available: true,
      source: 'keyring',
    });
  });

  it('logs out of persistent backends and supports unauthenticated local endpoints', async () => {
    const { encrypted, keyring, service } = setup();
    await service.login('openai-api-key', {
      credential: { type: 'api-key', secret: 'stored-secret' },
    });
    encrypted.values.set('openai-api-key:default', { type: 'api-key', secret: 'stale' });
    await service.logout('openai-api-key');
    expect(keyring.values.size).toBe(0);
    expect(encrypted.values.size).toBe(0);
    await expect(service.getCredentials('none')).resolves.toEqual({ type: 'none' });
  });

  it('returns secret-free status and registers resolved secrets for redaction', async () => {
    const { service } = setup({ OPENAI_API_KEY: 'do-not-leak' });
    const status = await service.status('openai-api-key');
    expect(JSON.stringify(status)).not.toContain('do-not-leak');
    await service.getCredentials('openai-api-key');
    expect(redact('request failed for do-not-leak')).toBe('request failed for [REDACTED]');
    expect(
      new PlinthwayError('AUTH_FAILED', 'provider rejected do-not-leak').toJSON(),
    ).toMatchObject({ message: 'provider rejected [REDACTED]' });
  });

  it('returns typed safe failures for unknown plugins and missing credentials', async () => {
    const { service } = setup();
    await expect(service.getCredentials('missing')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    await expect(service.getCredentials('openai-api-key')).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
  });

  it('can unlock a migrated encrypted credential file with the legacy passphrase variable', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-legacy-passphrase-'));
    const credentialsFile = path.join(directory, 'credentials.enc');
    const encrypted = new EncryptedFileCredentialStore(credentialsFile, () =>
      Promise.resolve('legacy-passphrase'),
    );
    await encrypted.set('openai-api-key:default', {
      type: 'api-key',
      secret: 'migrated-secret',
    });
    const keyring = new MemoryStore('keyring');
    const service = createDefaultAuthService({
      environment: { HARNESS_CREDENTIAL_PASSPHRASE: 'legacy-passphrase' },
      credentialsFile,
      keyring,
    });

    await expect(service.getCredentials('openai-api-key')).resolves.toMatchObject({
      secret: 'migrated-secret',
    });
  });
});
