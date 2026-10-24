import { describe, expect, it } from 'vitest';

import { canonicalJson, deepFreeze, sha256 } from './json.js';

describe('canonical JSON', () => {
  it('keeps hashes stable when object insertion order changes', () => {
    expect(sha256(canonicalJson({ b: 2, a: 1 }))).toBe(sha256(canonicalJson({ a: 1, b: 2 })));
  });

  it('sorts nested keys without reordering arrays', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n])(
    'rejects non-JSON value %s',
    (value) => {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    },
  );

  it('copies before deeply freezing', () => {
    const source = { nested: { value: 1 }, list: [{ value: 2 }] };
    const frozen = deepFreeze(source);

    source.nested.value = 9;

    expect(frozen).toEqual({ nested: { value: 1 }, list: [{ value: 2 }] });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.list[0])).toBe(true);
  });

  it('produces a lowercase SHA-256 digest', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
