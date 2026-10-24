import { describe, expect, it } from 'vitest';
import { PLINTHWAY_VERSION } from '@plinthway/shared';

describe('workspace', () => {
  it('resolves internal ESM packages', () => {
    expect(PLINTHWAY_VERSION).toMatch(/^0\.1\.0$/);
  });
});
