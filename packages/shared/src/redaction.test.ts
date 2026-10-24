import { describe, expect, it } from 'vitest';

import { redact, registerRedactionSecret } from './redaction.js';

describe('redaction', () => {
  it('redacts secret-looking keys and registered values recursively', () => {
    expect(
      redact(
        {
          authorization: 'Bearer abc',
          nested: { apiKey: 'abc', safe: 'prefix-abc-suffix' },
        },
        ['abc'],
      ),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'prefix-[REDACTED]-suffix' },
    });
  });

  it('redacts values registered for a process lifecycle', () => {
    const unregister = registerRedactionSecret('live-secret');
    try {
      expect(redact(['live-secret', 'safe'])).toEqual(['[REDACTED]', 'safe']);
    } finally {
      unregister();
    }

    expect(redact('live-secret')).toBe('live-secret');
  });

  it('does not mutate the input', () => {
    const input = { password: 'hidden', safe: 'shown' };
    redact(input);
    expect(input).toEqual({ password: 'hidden', safe: 'shown' });
  });

  it('preserves non-secret token usage counters', () => {
    expect(redact({ inputTokens: 10, outputTokens: 20, token: 'secret' })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      token: '[REDACTED]',
    });
  });
});
