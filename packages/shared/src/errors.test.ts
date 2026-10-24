import { describe, expect, it } from 'vitest';

import { PlinthwayError } from './errors.js';
import { registerRedactionSecret } from './redaction.js';

describe('PlinthwayError', () => {
  it('serializes a stable code without leaking registered secrets', () => {
    const unregister = registerRedactionSecret('sk-sensitive');
    try {
      const error = new PlinthwayError('AUTH_FAILED', 'provider rejected sk-sensitive', {
        response: 'token sk-sensitive',
        password: 'sk-sensitive',
      });

      expect(error.toJSON()).toEqual({
        name: 'PlinthwayError',
        code: 'AUTH_FAILED',
        message: 'provider rejected [REDACTED]',
        details: { response: 'token [REDACTED]', password: '[REDACTED]' },
      });
    } finally {
      unregister();
    }
  });

  it('preserves the standard Error cause without serializing it', () => {
    const cause = new Error('upstream');
    const error = new PlinthwayError('STORAGE_ERROR', 'write failed', {}, { cause });

    expect(error.cause).toBe(cause);
    expect(error.toJSON()).not.toHaveProperty('cause');
  });
});
