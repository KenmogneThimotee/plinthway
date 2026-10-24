import { describe, expect, it } from 'vitest';

import { PlinthwayError } from '@plinthway/shared';

import { transitionAgentState, type AgentState } from './state-machine.js';

describe('transitionAgentState', () => {
  it('accepts the legal execution lifecycle', () => {
    let state: AgentState = { tag: 'idle' };
    state = transitionAgentState(state, { type: 'start', step: 1 });
    state = transitionAgentState(state, {
      type: 'approval-requested',
      call: { callId: 'call-1', toolName: 'files.read', input: {} },
    });
    state = transitionAgentState(state, { type: 'approval-granted' });
    state = transitionAgentState(state, { type: 'tool-finished', nextStep: 2 });
    state = transitionAgentState(state, { type: 'finish', status: 'completed' });
    expect(state).toEqual({ tag: 'terminal', status: 'completed' });
  });

  it('rejects illegal transitions', () => {
    expect(() =>
      transitionAgentState({ tag: 'idle' }, { type: 'finish', status: 'completed' }),
    ).toThrow(PlinthwayError);
  });
});
