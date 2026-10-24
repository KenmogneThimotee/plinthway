import type { JsonValue } from '@plinthway/shared';

export type TuiPhase =
  'idle' | 'composing' | 'running' | 'updating-mcp' | 'awaiting-approval' | 'error';
export type TuiOverlay =
  | 'profiles'
  | 'models'
  | 'mcp'
  | 'tools'
  | 'sessions'
  | 'auth'
  | 'help'
  | 'onboarding'
  | 'provider-setup'
  | 'chatgpt-auth'
  | 'approval';
export type ConversationTone = 'normal' | 'muted' | 'success' | 'warning' | 'error';

export interface TuiConversationItem {
  readonly id: number;
  readonly kind: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  readonly text: string;
  readonly tone: ConversationTone;
}

export interface ApprovalView {
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly targets?: readonly string[];
  readonly readOnlyHint?: boolean;
  readonly sideEffects?: string;
  readonly submitting?: boolean;
}

export interface TuiState {
  readonly phase: TuiPhase;
  readonly composer: string;
  readonly overlay?: TuiOverlay | undefined;
  readonly activeProfileId?: string | undefined;
  readonly effectiveModel?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly mcpHealth: 'disconnected' | 'healthy' | 'degraded';
  readonly conversation: readonly TuiConversationItem[];
  readonly approval?: ApprovalView | undefined;
  readonly terminal: { readonly width: number; readonly height: number };
  readonly error?: string | undefined;
  readonly nextItemId: number;
}

export type TuiEvent =
  | { readonly type: 'composer-changed'; readonly value: string }
  | { readonly type: 'message-submitted'; readonly text: string }
  | { readonly type: 'assistant-delta'; readonly text: string }
  | { readonly type: 'tool-summary'; readonly text: string; readonly tone?: ConversationTone }
  | { readonly type: 'system-message'; readonly text: string; readonly tone?: ConversationTone }
  | { readonly type: 'approval-requested'; readonly approval: ApprovalView }
  | { readonly type: 'approval-resolved'; readonly decision: 'allow-once' | 'deny' }
  | { readonly type: 'approval-submitting' }
  | { readonly type: 'run-finished' }
  | { readonly type: 'run-cancelled' }
  | { readonly type: 'mcp-update-started' }
  | { readonly type: 'mcp-update-finished' }
  | { readonly type: 'submission-failed'; readonly prompt: string; readonly message: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'error-cleared' }
  | { readonly type: 'overlay-opened'; readonly overlay: TuiOverlay }
  | { readonly type: 'overlay-closed' }
  | {
      readonly type: 'profile-activated';
      readonly profileId: string;
      readonly modelRef?: string | undefined;
    }
  | { readonly type: 'session-created'; readonly sessionId: string }
  | { readonly type: 'session-cleared' }
  | { readonly type: 'mcp-health'; readonly health: TuiState['mcpHealth'] }
  | { readonly type: 'resized'; readonly width: number; readonly height: number };

export function initialTuiState(
  options: { readonly width?: number; readonly height?: number } = {},
): TuiState {
  return {
    phase: 'idle',
    composer: '',
    mcpHealth: 'disconnected',
    conversation: [],
    terminal: { width: options.width ?? 80, height: options.height ?? 24 },
    nextItemId: 1,
  };
}

function append(state: TuiState, item: Omit<TuiConversationItem, 'id'>): TuiState {
  return {
    ...state,
    conversation: [...state.conversation, { id: state.nextItemId, ...item }],
    nextItemId: state.nextItemId + 1,
  };
}

export function tuiReducer(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'composer-changed':
      return {
        ...state,
        composer: event.value,
        phase:
          state.phase === 'running' ||
          state.phase === 'updating-mcp' ||
          state.phase === 'awaiting-approval'
            ? state.phase
            : 'composing',
        error: undefined,
      };
    case 'message-submitted':
      return append(
        { ...state, composer: '', phase: 'running', overlay: undefined, error: undefined },
        { kind: 'user', text: event.text, tone: 'normal' },
      );
    case 'assistant-delta': {
      const last = state.conversation.at(-1);
      if (last?.kind === 'assistant') {
        return {
          ...state,
          conversation: [
            ...state.conversation.slice(0, -1),
            { ...last, text: `${last.text}${event.text}` },
          ],
        };
      }
      return append(state, { kind: 'assistant', text: event.text, tone: 'normal' });
    }
    case 'tool-summary':
      return append(state, { kind: 'tool', text: event.text, tone: event.tone ?? 'muted' });
    case 'system-message':
      return append(state, { kind: 'system', text: event.text, tone: event.tone ?? 'muted' });
    case 'approval-requested':
      return {
        ...state,
        phase: 'awaiting-approval',
        overlay: 'approval',
        approval: event.approval,
      };
    case 'approval-submitting':
      return state.approval === undefined
        ? state
        : { ...state, approval: { ...state.approval, submitting: true } };
    case 'approval-resolved':
      return append(
        { ...state, phase: 'running', overlay: undefined, approval: undefined },
        {
          kind: 'system',
          text:
            event.decision === 'allow-once'
              ? 'Tool invocation allowed once'
              : 'Tool invocation denied',
          tone: event.decision === 'allow-once' ? 'success' : 'warning',
        },
      );
    case 'run-finished':
      return { ...state, phase: 'idle', error: undefined };
    case 'run-cancelled':
      return append(
        { ...state, phase: 'idle', overlay: undefined, approval: undefined },
        { kind: 'system', text: 'Execution cancelled', tone: 'warning' },
      );
    case 'mcp-update-started':
      return { ...state, phase: 'updating-mcp', error: undefined };
    case 'mcp-update-finished':
      return { ...state, phase: state.composer.length > 0 ? 'composing' : 'idle' };
    case 'error':
      return append(
        { ...state, phase: 'error', error: event.message },
        { kind: 'error', text: event.message, tone: 'error' },
      );
    case 'error-cleared':
      return {
        ...state,
        phase: state.composer.length > 0 ? 'composing' : 'idle',
        error: undefined,
      };
    case 'submission-failed':
      return append(
        {
          ...state,
          composer: event.prompt,
          phase: 'composing',
          sessionId: undefined,
          error: event.message,
        },
        { kind: 'error', text: event.message, tone: 'error' },
      );
    case 'overlay-opened':
      return { ...state, overlay: event.overlay };
    case 'overlay-closed':
      return { ...state, overlay: undefined };
    case 'profile-activated':
      return { ...state, activeProfileId: event.profileId, effectiveModel: event.modelRef };
    case 'session-created':
      return { ...state, sessionId: event.sessionId };
    case 'session-cleared':
      return { ...state, sessionId: undefined };
    case 'mcp-health':
      return { ...state, mcpHealth: event.health };
    case 'resized':
      return { ...state, terminal: { width: event.width, height: event.height } };
  }
}
