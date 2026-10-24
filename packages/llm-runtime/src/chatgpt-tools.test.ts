import { describe, expect, it } from 'vitest';

import { ChatGptToolMap } from './chatgpt-tools.js';

describe('ChatGptToolMap', () => {
  it('creates deterministic safe aliases and reverses them', () => {
    const toolMap = new ChatGptToolMap(['shell.run', 'github/issues.create', 'odd tool.!']);
    for (const original of ['shell.run', 'github/issues.create', 'odd tool.!']) {
      const alias = toolMap.alias(original);
      expect(alias).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u);
      expect(toolMap.originalName(alias)).toBe(original);
    }
  });

  it('keeps punctuation-heavy names distinct', () => {
    const toolMap = new ChatGptToolMap(['server.a-b', 'server.a_b', 'server.a b']);
    expect(
      new Set(['server.a-b', 'server.a_b', 'server.a b'].map((name) => toolMap.alias(name))).size,
    ).toBe(3);
  });

  it('fails closed for aliases that were not offered', () => {
    const toolMap = new ChatGptToolMap(['shell.run']);
    expect(() => toolMap.originalName('invented')).toThrow(/unknown ChatGPT tool alias/iu);
  });
});
