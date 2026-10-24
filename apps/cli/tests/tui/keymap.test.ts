import { describe, expect, it } from 'vitest';

import { resolveKeyAction, type KeyInput } from '../../src/tui/keymap.js';

const keymap = {
  commandPalette: 'ctrl+p',
  submit: 'enter',
  newline: 'alt+enter',
  close: 'escape',
  cancel: 'ctrl+c',
  complete: 'tab',
};

describe('resolveKeyAction', () => {
  it.each([
    [{ return: true }, 'submit'],
    [{ return: true, meta: true }, 'newline'],
    [{ escape: true }, 'close'],
    [{ ctrl: true, name: 'c' }, 'cancel'],
    [{ ctrl: true, name: 'p' }, 'palette'],
    [{ tab: true }, 'complete'],
  ] satisfies [KeyInput, string][])('maps configured keyboard input', (input, action) => {
    expect(resolveKeyAction(input, keymap)).toBe(action);
  });

  it.each([
    [{ pageUp: true }, 'scroll-up'],
    [{ pageDown: true }, 'scroll-down'],
    [{ end: true }, 'scroll-end'],
  ])('maps conversation scrolling input', (input, action) => {
    expect(resolveKeyAction(input as KeyInput, keymap)).toBe(action);
  });
});
