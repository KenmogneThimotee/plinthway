import { describe, expect, it } from 'vitest';

import { initialStartupState, startupReducer } from '../../src/tui/startup.js';

describe('chat startup', () => {
  it('blocks chat until model synchronization succeeds', () => {
    let state = initialStartupState();
    state = startupReducer(state, { type: 'failed', message: 'offline' });
    expect(state).toEqual({ phase: 'blocked', message: 'offline', attempt: 0 });

    state = startupReducer(state, { type: 'retry' });
    expect(state).toEqual({ phase: 'syncing', attempt: 1 });

    state = startupReducer(state, { type: 'succeeded', source: 'cache', fallback: true });
    expect(state).toEqual({
      phase: 'ready',
      attempt: 1,
      notice: 'Network unavailable; using the cached model catalog.',
    });
  });

  it('enters ready state without a warning after a network sync', () => {
    expect(
      startupReducer(initialStartupState(), {
        type: 'succeeded',
        source: 'cache',
        fallback: false,
      }),
    ).toEqual({ phase: 'ready', attempt: 0 });
  });
});
