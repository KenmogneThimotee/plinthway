import { describe, expect, it } from 'vitest';

import { initialTuiState, tuiReducer } from '../../src/tui/reducer.js';

describe('tuiReducer', () => {
  it('moves through composing, running, approval, and idle states', () => {
    let state = initialTuiState();
    state = tuiReducer(state, { type: 'composer-changed', value: 'hello' });
    expect(state.phase).toBe('composing');
    state = tuiReducer(state, { type: 'message-submitted', text: 'hello' });
    expect(state.phase).toBe('running');
    state = tuiReducer(state, {
      type: 'approval-requested',
      approval: { serverId: 'shell', toolName: 'shell.run', arguments: { command: 'pwd' } },
    });
    expect(state.phase).toBe('awaiting-approval');
    state = tuiReducer(state, { type: 'approval-resolved', decision: 'deny' });
    state = tuiReducer(state, { type: 'run-finished' });
    expect(state.phase).toBe('idle');
  });

  it('preserves the composer on errors and overlay close', () => {
    let state = tuiReducer(initialTuiState(), { type: 'composer-changed', value: 'draft' });
    state = tuiReducer(state, { type: 'overlay-opened', overlay: 'auth' });
    state = tuiReducer(state, { type: 'error', message: 'authentication required' });
    expect(state.composer).toBe('draft');
    state = tuiReducer(state, { type: 'overlay-closed' });
    expect(state.composer).toBe('draft');
    expect(state.overlay).toBeUndefined();
  });

  it('prints a failed submission and restores the exact prompt for retry', () => {
    let state = tuiReducer(initialTuiState(), { type: 'composer-changed', value: 'explain this' });
    state = tuiReducer(state, { type: 'message-submitted', text: 'explain this' });
    state = tuiReducer(state, {
      type: 'submission-failed',
      prompt: 'explain this',
      message: 'No model selected for profile default. Use /provider or /model.',
    });

    expect(state.phase).toBe('composing');
    expect(state.composer).toBe('explain this');
    expect(state.conversation.at(-1)).toMatchObject({
      kind: 'error',
      text: 'No model selected for profile default. Use /provider or /model.',
    });
    expect(state.sessionId).toBeUndefined();
  });

  it('does not change active profile from a submitted natural-language message', () => {
    const active = tuiReducer(initialTuiState(), {
      type: 'profile-activated',
      profileId: 'coding',
      modelRef: 'openai/test',
    });
    const submitted = tuiReducer(active, {
      type: 'message-submitted',
      text: 'switch to research now',
    });
    expect(submitted.activeProfileId).toBe('coding');
  });

  it('tracks terminal resizing and explicit new sessions', () => {
    let state = tuiReducer(initialTuiState(), { type: 'resized', width: 60, height: 20 });
    state = tuiReducer(state, { type: 'session-created', sessionId: 'session-1' });
    expect(state.terminal).toEqual({ width: 60, height: 20 });
    expect(state.sessionId).toBe('session-1');
  });

  it('blocks composition while MCP connections are changing', () => {
    let state = tuiReducer(initialTuiState(), { type: 'mcp-update-started' });
    expect(state.phase).toBe('updating-mcp');
    state = tuiReducer(state, { type: 'composer-changed', value: 'wait for this' });
    expect(state.phase).toBe('updating-mcp');
    state = tuiReducer(state, { type: 'mcp-update-finished' });
    expect(state.phase).toBe('composing');
  });
});
