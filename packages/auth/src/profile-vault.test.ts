import { describe, expect, it } from 'vitest';

import { redact } from '@plinthway/shared';

import type { Credential, CredentialStore } from './contracts.js';
import { ProfileCredentialVault } from './profile-vault.js';

class MemoryKeyring implements CredentialStore {
  readonly source = 'keyring' as const;
  readonly values = new Map<string, Credential>();
  unavailable = false;

  get(key: string): Promise<Credential | null> {
    if (this.unavailable) return Promise.reject(new Error('locked'));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, credential: Credential): Promise<void> {
    if (this.unavailable) return Promise.reject(new Error('locked'));
    this.values.set(key, credential);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.unavailable) return Promise.reject(new Error('locked'));
    this.values.delete(key);
    return Promise.resolve();
  }
}

describe('ProfileCredentialVault', () => {
  it('isolates and redacts API keys by profile and provider', async () => {
    const keyring = new MemoryKeyring();
    const vault = new ProfileCredentialVault(keyring);

    await vault.setApiKey('coding', 'openai', 'coding-secret');
    await vault.setApiKey('research', 'openai', 'research-secret');

    await expect(vault.get('coding', 'openai')).resolves.toEqual({
      type: 'api-key',
      secret: 'coding-secret',
    });
    await expect(vault.get('research', 'openai')).resolves.toEqual({
      type: 'api-key',
      secret: 'research-secret',
    });
    expect(redact('coding-secret research-secret')).toBe('[REDACTED] [REDACTED]');
    await expect(vault.status('coding', 'openai')).resolves.toBe(true);
    await expect(vault.status('coding', 'missing')).resolves.toBe(false);
  });

  it('deletes one provider or every provider owned by a profile', async () => {
    const keyring = new MemoryKeyring();
    const vault = new ProfileCredentialVault(keyring);
    await vault.setApiKey('coding', 'openai', 'one');
    await vault.setApiKey('coding', 'anthropic', 'two');
    await vault.setApiKey('research', 'openai', 'three');

    await vault.deleteProvider('coding', 'openai');
    await expect(vault.get('coding', 'openai')).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
    await vault.deleteProfile('coding', ['anthropic']);
    await expect(vault.get('coding', 'anthropic')).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
    await expect(vault.get('research', 'openai')).resolves.toMatchObject({ secret: 'three' });
  });

  it('maps an unavailable keyring to a typed error without retaining the secret', async () => {
    const keyring = new MemoryKeyring();
    keyring.unavailable = true;
    const vault = new ProfileCredentialVault(keyring);

    await expect(vault.setApiKey('coding', 'openai', 'never-stored')).rejects.toMatchObject({
      code: 'KEYRING_UNAVAILABLE',
    });
    expect(keyring.values.size).toBe(0);
    expect(redact('never-stored')).toBe('never-stored');
  });
});
