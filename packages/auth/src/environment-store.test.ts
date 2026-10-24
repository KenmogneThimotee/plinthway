import { describe, expect, it } from 'vitest';

import { EnvironmentCredentialStore } from './environment-store.js';

describe('EnvironmentCredentialStore', () => {
  it('reads provider credentials without a persistence API', () => {
    const store = new EnvironmentCredentialStore({ OPENAI_API_KEY: 'env-secret' });
    expect(store.getApiKey('OPENAI_API_KEY')).toEqual({ type: 'api-key', secret: 'env-secret' });
    expect(store.getApiKey('MISSING')).toBeNull();
    expect(store).not.toHaveProperty('set');
  });
});
