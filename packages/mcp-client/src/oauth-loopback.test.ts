import { describe, expect, it } from 'vitest';

import { startOAuthLoopbackCallback } from './oauth-loopback.js';

describe('OAuth loopback callback', () => {
  it('binds a random 127.0.0.1 port and validates state and issuer inputs', async () => {
    const callback = await startOAuthLoopbackCallback({ expectedState: 'opaque-state' });
    try {
      expect(callback.redirectUrl.hostname).toBe('127.0.0.1');
      expect(callback.redirectUrl.port).not.toBe('0');
      const response = await fetch(
        `${callback.redirectUrl.href}?code=callback-code&state=opaque-state&iss=${encodeURIComponent('https://issuer.example.com')}`,
      );
      expect(response.status).toBe(200);
      const message = await response.text();
      expect(message).toBe(
        'Authorization received. Return to the terminal while the connection completes.',
      );
      expect(message).not.toContain('Authorization complete');
      await expect(callback.result).resolves.toEqual({
        code: 'callback-code',
        state: 'opaque-state',
        issuer: 'https://issuer.example.com',
      });
    } finally {
      await callback.close();
    }
  });

  it('rejects mismatched state without exposing a callback code', async () => {
    const callback = await startOAuthLoopbackCallback({ expectedState: 'expected' });
    try {
      const rejected = expect(callback.result).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      const response = await fetch(`${callback.redirectUrl.href}?code=stolen&state=wrong`);
      expect(response.status).toBe(400);
      await rejected;
    } finally {
      await callback.close();
    }
  });
});
