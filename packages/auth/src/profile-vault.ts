import { PlinthwayError, registerRedactionSecret } from '@plinthway/shared';

import type { Credential, CredentialStore } from './contracts.js';

function account(profileId: string, providerId: string): string {
  return `profile:${profileId}:provider:${providerId}`;
}

function unavailable(error: unknown): PlinthwayError {
  return new PlinthwayError(
    'KEYRING_UNAVAILABLE',
    'The operating-system credential store is unavailable',
    {},
    { cause: error },
  );
}

export class ProfileCredentialVault {
  readonly #keyring: CredentialStore;
  readonly #redactions = new Map<string, () => void>();

  constructor(keyring: CredentialStore) {
    if (keyring.source !== 'keyring') {
      throw new TypeError('Profile credentials require an operating-system keyring');
    }
    this.#keyring = keyring;
  }

  #register(key: string, credential: Credential): void {
    if (credential.type !== 'api-key') return;
    this.#redactions.get(key)?.();
    this.#redactions.set(key, registerRedactionSecret(credential.secret));
  }

  async get(profileId: string, providerId: string): Promise<Credential> {
    const key = account(profileId, providerId);
    let credential: Credential | null;
    try {
      credential = await this.#keyring.get(key);
    } catch (error) {
      throw unavailable(error);
    }
    if (credential === null) {
      throw new PlinthwayError(
        'CREDENTIAL_MISSING',
        'No credential is available for this provider',
        {
          profileId,
          providerId,
        },
      );
    }
    this.#register(key, credential);
    return credential;
  }

  async setApiKey(profileId: string, providerId: string, secret: string): Promise<void> {
    if (secret.length === 0) {
      throw new PlinthwayError('CREDENTIAL_MISSING', 'An API key is required');
    }
    const key = account(profileId, providerId);
    const credential = { type: 'api-key' as const, secret };
    try {
      await this.#keyring.set(key, credential);
    } catch (error) {
      throw unavailable(error);
    }
    this.#register(key, credential);
  }

  async status(profileId: string, providerId: string): Promise<boolean> {
    try {
      await this.get(profileId, providerId);
      return true;
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'CREDENTIAL_MISSING') return false;
      throw error;
    }
  }

  async deleteProvider(profileId: string, providerId: string): Promise<void> {
    const key = account(profileId, providerId);
    try {
      await this.#keyring.delete(key);
    } catch (error) {
      throw unavailable(error);
    }
    this.#redactions.get(key)?.();
    this.#redactions.delete(key);
  }

  async deleteProfile(profileId: string, providerIds: readonly string[]): Promise<void> {
    for (const providerId of providerIds) await this.deleteProvider(profileId, providerId);
  }
}
