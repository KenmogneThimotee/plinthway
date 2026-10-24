import { describe, expect, it } from 'vitest';

import { matchToolRule, validateToolPattern } from './matcher.js';

describe('tool rule matching', () => {
  it('prefers exact rules over wildcards and deny on equal specificity', () => {
    expect(
      matchToolRule('files.write', [
        { tool: 'files.*', action: 'deny' },
        { tool: 'files.write', action: 'allow' },
      ]),
    ).toMatchObject({ tool: 'files.write', action: 'allow', exact: true });

    expect(
      matchToolRule('files.read', [
        { tool: 'files.*', action: 'allow' },
        { tool: 'files.*', action: 'deny' },
      ]),
    ).toMatchObject({ action: 'deny', exact: false });
  });

  it.each(['*', 'files.**', '*.read', 'files.re*ad', 'files'])(
    'rejects broad glob %s',
    (pattern) => {
      expect(() => {
        validateToolPattern(pattern);
      }).toThrow();
    },
  );
});
