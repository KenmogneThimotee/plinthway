import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '@plinthway/config';
import { PlinthwayError } from '@plinthway/shared';
import lockfile from 'proper-lockfile';

import type { ChatGptConnectionSummary } from './contracts.js';

interface AccountsDocument {
  readonly schemaVersion: 1;
  readonly connections: readonly ChatGptConnectionSummary[];
}

const BARE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canonicalHostId(value: string): string {
  return BARE_UUID_V4.test(value) ? `urn:uuid:${value}` : value;
}

function parseConnection(value: unknown): ChatGptConnectionSummary {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !('clientId' in value) ||
    typeof value.clientId !== 'string' ||
    value.clientId.length === 0 ||
    !('subject' in value) ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    !('status' in value) ||
    !['connected', 'disconnected', 'reauthentication-required'].includes(String(value.status)) ||
    !('sharing' in value) ||
    typeof value.sharing !== 'boolean' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    ('email' in value && value.email !== undefined && typeof value.email !== 'string') ||
    ('displayName' in value &&
      value.displayName !== undefined &&
      typeof value.displayName !== 'string')
  ) {
    throw new TypeError('Invalid ChatGPT account metadata');
  }
  return value as ChatGptConnectionSummary;
}

function parseDocument(value: unknown): AccountsDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('connections' in value) ||
    !Array.isArray(value.connections)
  ) {
    throw new TypeError('Invalid ChatGPT account metadata');
  }
  return {
    schemaVersion: 1,
    connections: value.connections.map(parseConnection),
  };
}

export class ChatGptMetadataStore {
  readonly #accountsFile: string;
  readonly #hostFile: string;

  constructor(accountsFile: string, hostFile: string) {
    this.#accountsFile = accountsFile;
    this.#hostFile = hostFile;
  }

  async hostId(create: () => string): Promise<string> {
    await mkdir(path.dirname(this.#hostFile), { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.#hostFile, 'utf8')) as unknown;
      if (
        typeof value === 'object' &&
        value !== null &&
        'hostId' in value &&
        typeof value.hostId === 'string'
      ) {
        const hostId = canonicalHostId(value.hostId);
        if (hostId !== value.hostId) {
          await atomicWriteFile(
            this.#hostFile,
            `${JSON.stringify({ schemaVersion: 1, hostId }, null, 2)}\n`,
          );
        }
        return hostId;
      }
      throw new TypeError('Invalid host metadata');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PlinthwayError(
          'AUTH_FAILED',
          'ChatGPT host metadata is invalid',
          {},
          { cause: error },
        );
      }
      const hostId = canonicalHostId(create());
      await atomicWriteFile(
        this.#hostFile,
        `${JSON.stringify({ schemaVersion: 1, hostId }, null, 2)}\n`,
      );
      return hostId;
    }
  }

  async read(): Promise<readonly ChatGptConnectionSummary[]> {
    try {
      return parseDocument(JSON.parse(await readFile(this.#accountsFile, 'utf8')) as unknown)
        .connections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new PlinthwayError(
        'AUTH_FAILED',
        'ChatGPT account metadata is invalid',
        {},
        { cause: error },
      );
    }
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.#accountsFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        this.#accountsFile,
        `${JSON.stringify({ schemaVersion: 1, connections: [] }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const release = await lockfile.lock(this.#accountsFile, {
      realpath: false,
      retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async update(
    operation: (
      connections: readonly ChatGptConnectionSummary[],
    ) => readonly ChatGptConnectionSummary[],
  ): Promise<readonly ChatGptConnectionSummary[]> {
    return this.exclusive(async () => {
      const next = operation(await this.read());
      await atomicWriteFile(
        this.#accountsFile,
        `${JSON.stringify({ schemaVersion: 1, connections: next }, null, 2)}\n`,
      );
      return next;
    });
  }
}
