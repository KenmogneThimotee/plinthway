import type {
  McpResponseCacheEntry,
  McpResponseCacheKey,
  McpResponseCacheStore,
} from './contracts.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredEntry {
  readonly key: McpResponseCacheKey;
  readonly entry: McpResponseCacheEntry;
  readonly bytes: number;
}

export interface BoundedResponseCacheStoreOptions {
  readonly maxBytes?: number;
  readonly now?: () => number;
}

function serializeKey(key: McpResponseCacheKey): string {
  return JSON.stringify([
    key.method,
    ...(key.params === undefined ? [] : [key.params]),
    ...(key.partition === undefined ? [] : [key.partition]),
  ]);
}

function byteLength(key: string, value: string): number {
  return Buffer.byteLength(key) + Buffer.byteLength(value);
}

export class BoundedResponseCacheStore implements McpResponseCacheStore {
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, StoredEntry>();
  #sizeBytes = 0;
  #stamp = 0;

  constructor(options: BoundedResponseCacheStoreOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 0) {
      throw new RangeError('MCP response cache maxBytes must be a non-negative safe integer');
    }
  }

  get sizeBytes(): number {
    return this.#sizeBytes;
  }

  get(key: McpResponseCacheKey): McpResponseCacheEntry | undefined {
    const serialized = serializeKey(key);
    const stored = this.#entries.get(serialized);
    if (stored === undefined) return undefined;
    this.#entries.delete(serialized);
    this.#entries.set(serialized, stored);
    return stored.entry;
  }

  set(
    key: McpResponseCacheKey,
    value: {
      readonly value: string;
      readonly expiresAt?: number;
      readonly scope?: 'public' | 'private';
    },
  ): number {
    const serialized = serializeKey(key);
    const existing = this.#entries.get(serialized);
    if (existing !== undefined) {
      this.#entries.delete(serialized);
      this.#sizeBytes -= existing.bytes;
    }
    const maximumExpiry = this.#now() + MAX_TTL_MS;
    const expiresAt =
      value.expiresAt === undefined ? undefined : Math.min(value.expiresAt, maximumExpiry);
    const stamp = ++this.#stamp;
    const entry: McpResponseCacheEntry = {
      value: value.value,
      stamp,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(value.scope === undefined ? {} : { scope: value.scope }),
    };
    const stored: StoredEntry = {
      key: { ...key },
      entry,
      bytes: byteLength(serialized, value.value),
    };
    this.#entries.set(serialized, stored);
    this.#sizeBytes += stored.bytes;
    this.#evictToBound();
    return stamp;
  }

  delete(key: McpResponseCacheKey): void {
    const serialized = serializeKey(key);
    const stored = this.#entries.get(serialized);
    if (stored === undefined) return;
    this.#entries.delete(serialized);
    this.#sizeBytes -= stored.bytes;
  }

  evict(method: string): void {
    for (const [serialized, stored] of this.#entries) {
      if (stored.key.method !== method) continue;
      this.#entries.delete(serialized);
      this.#sizeBytes -= stored.bytes;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#sizeBytes = 0;
  }

  #evictToBound(): void {
    while (this.#sizeBytes > this.#maxBytes) {
      const oldest = this.#entries.entries().next().value as
        readonly [string, StoredEntry] | undefined;
      if (oldest === undefined) return;
      this.#entries.delete(oldest[0]);
      this.#sizeBytes -= oldest[1].bytes;
    }
  }
}
