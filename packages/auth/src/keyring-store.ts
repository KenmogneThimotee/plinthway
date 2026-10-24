import { AsyncEntry } from '@napi-rs/keyring';
import { PlinthwayError } from '@plinthway/shared';

import { parseCredential, type Credential, type CredentialStore } from './contracts.js';

type Awaitable<T> = T | Promise<T>;

export interface KeyringEntry {
  setPassword(value: string): Awaitable<void>;
  getPassword(): Awaitable<string | null>;
  deletePassword(): Awaitable<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

const SERVICE_NAME = 'plinthway';
const LEGACY_SERVICE_NAME = 'local-agent-harness';

function isMissingEntry(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code).toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return code.includes('no_entry') || code.includes('noentry') || message.includes('no entry');
}

export class KeyringJsonStore<T> {
  readonly #entryFactory: KeyringEntryFactory;
  readonly #service: string;
  readonly #legacyServices: readonly string[];
  readonly #parse: (value: unknown) => T;

  constructor(options: {
    readonly service: string;
    readonly legacyServices?: readonly string[];
    readonly parse: (value: unknown) => T;
    readonly entryFactory?: KeyringEntryFactory;
  }) {
    this.#service = options.service;
    this.#legacyServices = options.legacyServices ?? [];
    this.#parse = options.parse;
    this.#entryFactory =
      options.entryFactory ?? ((service, account) => new AsyncEntry(service, account));
  }

  async get(account: string): Promise<T | null> {
    const services = [this.#service, ...this.#legacyServices];
    for (const service of services) {
      const value = await this.#read(service, account);
      if (value === null) continue;
      const parsed = this.#parseValue(value);
      if (service !== this.#service) await this.set(account, parsed);
      return parsed;
    }
    return null;
  }

  async #read(service: string, account: string): Promise<string | null> {
    try {
      return await this.#entryFactory(service, account).getPassword();
    } catch (error) {
      if (isMissingEntry(error)) return null;
      throw new PlinthwayError(
        'AUTH_FAILED',
        'The operating-system credential store is unavailable',
        {},
        { cause: error },
      );
    }
  }

  #parseValue(value: string): T {
    try {
      return this.#parse(JSON.parse(value) as unknown);
    } catch (error) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'The operating-system credential is invalid',
        {},
        { cause: error },
      );
    }
  }

  async set(account: string, value: T): Promise<void> {
    try {
      await this.#entryFactory(this.#service, account).setPassword(JSON.stringify(value));
    } catch (error) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not save credential to the operating-system store',
        {},
        { cause: error },
      );
    }
  }

  async delete(account: string): Promise<void> {
    let firstError: unknown;
    for (const service of [this.#service, ...this.#legacyServices]) {
      try {
        await this.#entryFactory(service, account).deletePassword();
      } catch (error) {
        if (!isMissingEntry(error) && firstError === undefined) firstError = error;
      }
    }
    if (firstError !== undefined) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not delete credential from the operating-system store',
        {},
        { cause: firstError },
      );
    }
  }
}

export class KeyringCredentialStore implements CredentialStore {
  readonly source = 'keyring' as const;
  readonly #entryFactory: KeyringEntryFactory;

  constructor(
    entryFactory: KeyringEntryFactory = (service, account) => new AsyncEntry(service, account),
  ) {
    this.#entryFactory = entryFactory;
  }

  #entry(account: string): KeyringEntry {
    return this.#entryFactory(SERVICE_NAME, account);
  }

  #legacyEntry(account: string): KeyringEntry {
    return this.#entryFactory(LEGACY_SERVICE_NAME, account);
  }

  async #read(entry: KeyringEntry): Promise<string | null> {
    try {
      return await entry.getPassword();
    } catch (error) {
      if (isMissingEntry(error)) return null;
      throw new PlinthwayError(
        'AUTH_FAILED',
        'The operating-system credential store is unavailable',
        {},
        { cause: error },
      );
    }
  }

  async get(account: string): Promise<Credential | null> {
    let serialized = await this.#read(this.#entry(account));
    let migrated = false;
    if (serialized === null) {
      serialized = await this.#read(this.#legacyEntry(account));
      migrated = serialized !== null;
    }
    if (serialized === null) return null;
    try {
      const credential = parseCredential(JSON.parse(serialized) as unknown);
      if (migrated) await this.set(account, credential);
      return credential;
    } catch (error) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'The operating-system credential is invalid',
        {},
        {
          cause: error,
        },
      );
    }
  }

  async set(account: string, credential: Credential): Promise<void> {
    try {
      await this.#entry(account).setPassword(JSON.stringify(credential));
    } catch (error) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not save credential to the operating-system store',
        {},
        {
          cause: error,
        },
      );
    }
  }

  async delete(account: string): Promise<void> {
    let firstError: unknown;
    for (const entry of [this.#entry(account), this.#legacyEntry(account)]) {
      try {
        await entry.deletePassword();
      } catch (error) {
        if (!isMissingEntry(error) && firstError === undefined) firstError = error;
      }
    }
    if (firstError !== undefined) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not delete credential from the operating-system store',
        {},
        { cause: firstError },
      );
    }
  }
}
