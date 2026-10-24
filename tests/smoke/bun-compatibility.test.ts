import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Bun compatibility policy', () => {
  it('documents Bun as a non-gating observation and Node 24 as the production runtime', async () => {
    const testing = await readFile(new URL('../../docs/testing.md', import.meta.url), 'utf8');
    expect(testing).toContain('Bun is evaluated separately and allowed to fail in CI');
    expect(testing).toContain('MVP remains Node-only');
    expect(testing).toContain('node:sqlite');
  });
});
