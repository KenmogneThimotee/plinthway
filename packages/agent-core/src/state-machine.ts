import { PlinthwayError, type ToolCall } from '@plinthway/shared';

export type AgentState =
  | { readonly tag: 'idle' }
  | { readonly tag: 'streaming'; readonly step: number }
  | { readonly tag: 'awaiting-approval'; readonly step: number; readonly call: ToolCall }
  | { readonly tag: 'executing-tool'; readonly step: number; readonly call: ToolCall }
  | { readonly tag: 'terminal'; readonly status: 'completed' | 'cancelled' | 'failed' };

export type AgentTransition =
  | { readonly type: 'start'; readonly step: number }
  | { readonly type: 'approval-requested'; readonly call: ToolCall }
  | { readonly type: 'approval-granted' }
  | { readonly type: 'tool-started'; readonly call: ToolCall }
  | { readonly type: 'tool-finished'; readonly nextStep: number }
  | { readonly type: 'finish'; readonly status: 'completed' | 'cancelled' | 'failed' };

function illegal(state: AgentState, event: AgentTransition): never {
  throw new PlinthwayError('PROVIDER_ERROR', 'Illegal agent state transition', {
    state: state.tag,
    event: event.type,
  });
}

export function transitionAgentState(state: AgentState, event: AgentTransition): AgentState {
  if (state.tag === 'terminal') return illegal(state, event);
  if (event.type === 'finish' && state.tag !== 'idle') {
    return { tag: 'terminal', status: event.status };
  }
  if (state.tag === 'idle' && event.type === 'start') {
    return { tag: 'streaming', step: event.step };
  }
  if (state.tag === 'streaming' && event.type === 'approval-requested') {
    return { tag: 'awaiting-approval', step: state.step, call: event.call };
  }
  if (state.tag === 'awaiting-approval' && event.type === 'approval-granted') {
    return { tag: 'executing-tool', step: state.step, call: state.call };
  }
  if (state.tag === 'streaming' && event.type === 'tool-started') {
    return { tag: 'executing-tool', step: state.step, call: event.call };
  }
  if (state.tag === 'executing-tool' && event.type === 'tool-finished') {
    return { tag: 'streaming', step: event.nextStep };
  }
  return illegal(state, event);
}
