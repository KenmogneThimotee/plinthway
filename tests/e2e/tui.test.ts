import { describe, expect, it } from 'vitest';

import { parseComposerInput } from '../../apps/cli/src/tui/commands.js';
import { resolveKeyAction } from '../../apps/cli/src/tui/keymap.js';
import { initialTuiState, tuiReducer } from '../../apps/cli/src/tui/reducer.js';

describe('scripted TUI flows', () => {
  it.each([
    ['shift+enter', { return: true, shift: true }],
    ['alt+enter', { return: true, meta: true }],
  ] as const)('supports keyboard-only composition with %s', (newline, key) => {
    const keymap = {
      commandPalette: 'ctrl+p',
      submit: 'enter',
      newline,
      close: 'escape',
      cancel: 'ctrl+c',
      complete: 'tab',
    };
    expect(resolveKeyAction(key, keymap)).toBe('newline');
    expect(resolveKeyAction({ return: true }, keymap)).toBe('submit');
  });

  it('does not forward an unknown command and preserves a blocked prompt', () => {
    expect(parseComposerInput('/profle').kind).toBe('unknown-command');
    let state = tuiReducer(initialTuiState(), {
      type: 'composer-changed',
      value: 'blocked prompt',
    });
    state = tuiReducer(state, { type: 'overlay-opened', overlay: 'auth' });
    state = tuiReducer(state, { type: 'error', message: 'credential missing' });
    expect(state.composer).toBe('blocked prompt');
  });
});
