import { describe, expect, it } from 'vitest';

import { acceptanceScenarios, tuiAcceptanceIds } from './scenarios.js';

const expected = Array.from(
  { length: 14 },
  (_, index) => `AT-TUI-${String(index + 1).padStart(2, '0')}`,
);

describe('TUI acceptance scenarios', () => {
  it('contains the exact AT-TUI-01 through AT-TUI-14 release set', () => {
    expect(tuiAcceptanceIds).toEqual(expected);
  });

  it.each(tuiAcceptanceIds)('%s', async (id) => {
    await acceptanceScenarios[id]();
  });
});
