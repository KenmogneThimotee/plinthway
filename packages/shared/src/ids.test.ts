import { describe, expect, it } from 'vitest';

import { asProfileId, newEventId, newExecutionId, newSessionId } from './ids.js';

describe('domain IDs', () => {
  it('accepts portable human profile IDs', () => {
    expect(asProfileId('coding-work')).toBe('coding-work');
  });

  it.each(['', '../escape', 'UPPER', 'two words'])('rejects unsafe profile ID %j', (value) => {
    expect(() => asProfileId(value)).toThrow(TypeError);
  });

  it('creates UUIDs for runtime entities', () => {
    for (const value of [newSessionId(), newExecutionId(), newEventId()]) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
