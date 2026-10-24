import { describe, expect, it, vi } from 'vitest';

import { BoundedResponseCacheStore } from './response-cache.js';

describe('BoundedResponseCacheStore', () => {
  it('partitions entries by the complete SDK key and preserves opaque empty params', () => {
    const cache = new BoundedResponseCacheStore({ maxBytes: 1024 });
    cache.set(
      { method: 'resources/read', params: '', partition: '["server","alice"]' },
      { value: 'private-a', scope: 'private' },
    );
    cache.set(
      { method: 'resources/read', params: '', partition: '["server","bob"]' },
      { value: 'private-b', scope: 'private' },
    );

    expect(
      cache.get({ method: 'resources/read', params: '', partition: '["server","alice"]' })?.value,
    ).toBe('private-a');
    expect(
      cache.get({ method: 'resources/read', partition: '["server","alice"]' }),
    ).toBeUndefined();
  });

  it('clamps TTLs to 24 hours and evicts least-recently-used bytes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00.000Z'));
    try {
      const cache = new BoundedResponseCacheStore({ maxBytes: 260 });
      const first = { method: 'resources/read', params: 'first', partition: 'server' };
      const second = { method: 'resources/read', params: 'second', partition: 'server' };
      const third = { method: 'resources/read', params: 'third', partition: 'server' };
      cache.set(first, { value: 'a'.repeat(80), expiresAt: Date.now() + 10 * 86_400_000 });
      cache.set(second, { value: 'b'.repeat(80) });
      expect(cache.get(first)?.expiresAt).toBe(Date.now() + 86_400_000);
      cache.get(first);
      cache.set(third, { value: 'c'.repeat(80) });

      expect(cache.get(first)).toBeDefined();
      expect(cache.get(second)).toBeUndefined();
      expect(cache.sizeBytes).toBeLessThanOrEqual(260);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports targeted notification invalidation without touching co-tenants', () => {
    const cache = new BoundedResponseCacheStore({ maxBytes: 1024 });
    const alice = { method: 'tools/list', params: '', partition: '["server","alice"]' };
    const bob = { method: 'tools/list', params: '', partition: '["server","bob"]' };
    cache.set(alice, { value: 'alice' });
    cache.set(bob, { value: 'bob' });
    cache.delete(alice);
    expect(cache.get(alice)).toBeUndefined();
    expect(cache.get(bob)?.value).toBe('bob');
    cache.evict('tools/list');
    expect(cache.get(bob)).toBeUndefined();
  });
});
