import { createCipheriv, createDecipheriv, randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '@plinthway/config';
import { PlinthwayError } from '@plinthway/shared';

import { parseCredential, type Credential, type CredentialStore } from './contracts.js';

const AUTHENTICATED_HEADER = Buffer.from(JSON.stringify({ version: 1 }), 'utf8');

interface EncryptedEnvelope {
  readonly version: 1;
  readonly kdf: 'scrypt';
  readonly cipher: 'aes-256-gcm';
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

type PassphraseProvider = () => Promise<string>;

function scrypt(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(passphrase, salt, 32, (error, derivedKey) => {
      if (error === null) resolve(derivedKey);
      else reject(error);
    });
  });
}

function parseEnvelope(value: unknown): EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Invalid credential envelope');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.kdf !== 'scrypt' || record.cipher !== 'aes-256-gcm') {
    throw new TypeError('Invalid credential envelope');
  }
  const { salt, iv, tag, ciphertext } = record;
  if (
    typeof salt !== 'string' ||
    typeof iv !== 'string' ||
    typeof tag !== 'string' ||
    typeof ciphertext !== 'string'
  ) {
    throw new TypeError('Invalid credential envelope');
  }
  return {
    version: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt,
    iv,
    tag,
    ciphertext,
  };
}

function parseCredentialMap(value: unknown): Record<string, Credential> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid credential file payload');
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, credential]) => [key, parseCredential(credential)]),
  );
}

function authenticationFailure(cause: unknown): PlinthwayError {
  return new PlinthwayError(
    'AUTH_FAILED',
    'Could not unlock encrypted credentials; check the passphrase and file integrity',
    {},
    { cause },
  );
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly source = 'encrypted-file' as const;
  readonly #file: string;
  readonly #passphrase: PassphraseProvider;

  constructor(file: string, passphrase: PassphraseProvider) {
    this.#file = file;
    this.#passphrase = passphrase;
  }

  async #readAll(): Promise<Record<string, Credential> | null> {
    let serialized: string;
    try {
      serialized = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not read encrypted credentials',
        {},
        {
          cause: error,
        },
      );
    }

    try {
      const envelope = parseEnvelope(JSON.parse(serialized) as unknown);
      const passphrase = await this.#passphrase();
      if (passphrase.length === 0) throw new Error('Empty passphrase');
      const key = await scrypt(passphrase, Buffer.from(envelope.salt, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(AUTHENTICATED_HEADER);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return parseCredentialMap(JSON.parse(plaintext) as unknown);
    } catch (error) {
      throw authenticationFailure(error);
    }
  }

  async #writeAll(credentials: Readonly<Record<string, Credential>>): Promise<void> {
    try {
      const passphrase = await this.#passphrase();
      if (passphrase.length === 0) throw new Error('Empty passphrase');
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = await scrypt(passphrase, salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AUTHENTICATED_HEADER);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(credentials), 'utf8'),
        cipher.final(),
      ]);
      const envelope: EncryptedEnvelope = {
        version: 1,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
      await atomicWriteFile(this.#file, JSON.stringify(envelope));
    } catch (error) {
      if (error instanceof PlinthwayError) throw error;
      throw authenticationFailure(error);
    }
  }

  async get(key: string): Promise<Credential | null> {
    return (await this.#readAll())?.[key] ?? null;
  }

  async set(key: string, credential: Credential): Promise<void> {
    const credentials = (await this.#readAll()) ?? {};
    await this.#writeAll({ ...credentials, [key]: credential });
  }

  async delete(key: string): Promise<void> {
    const credentials = await this.#readAll();
    if (credentials === null || !(key in credentials)) return;
    const next = Object.fromEntries(
      Object.entries(credentials).filter(([candidate]) => candidate !== key),
    );
    await this.#writeAll(next);
  }
}
