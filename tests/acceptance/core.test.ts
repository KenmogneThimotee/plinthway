import { describe, expect, it } from 'vitest';

import { acceptanceScenarios, coreAcceptanceIds } from './scenarios.js';

const expected = Array.from(
  { length: 18 },
  (_, index) => `AT-${String(index + 1).padStart(2, '0')}`,
);

describe('core acceptance scenarios', () => {
  it('contains the exact AT-01 through AT-18 release set', () => {
    expect(coreAcceptanceIds).toEqual(expected);
  });

  it.each(coreAcceptanceIds)('%s', async (id) => {
    await acceptanceScenarios[id]();
  });
});
