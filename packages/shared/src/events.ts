import type { ExecutionStatus, JsonValue, ToolAction, ToolCall } from './contracts.js';
import type { EventId, ExecutionId } from './ids.js';

interface EventBase {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export type ExecutionEvent =
  | (EventBase & { readonly type: 'execution-started'; readonly executionId: ExecutionId })
  | (EventBase & { readonly type: 'user-message'; readonly content: string })
  | (EventBase & { readonly type: 'assistant-message'; readonly content: string })
  | (EventBase & { readonly type: 'model-selected'; readonly modelRef: string })
  | (EventBase & { readonly type: 'tool-requested'; readonly call: ToolCall })
  | (EventBase & {
      readonly type: 'policy-decided';
      readonly callId: string;
      readonly action: ToolAction;
      readonly reason: string;
    })
  | (EventBase & {
      readonly type: 'approval-decided';
      readonly callId: string;
      readonly decision: 'allow-once' | 'deny';
    })
  | (EventBase & {
      readonly type: 'tool-result';
      readonly callId: string;
      readonly toolName: string;
      readonly result: JsonValue;
      readonly trusted: false;
      readonly isError: boolean;
    })
  | (EventBase & {
      readonly type: 'usage-recorded';
      readonly inputTokens: number;
      readonly outputTokens: number;
    })
  | (EventBase & {
      readonly type: 'mcp-prompt-used';
      readonly serverId: string;
      readonly promptName: string;
      readonly argumentNames: readonly string[];
    })
  | (EventBase & {
      readonly type: 'mcp-resource-attached';
      readonly serverId: string;
      readonly uri: string;
      readonly mimeTypes: readonly string[];
    })
  | (EventBase & {
      readonly type: 'mcp-interaction-decided';
      readonly serverId: string;
      readonly method: 'roots/list' | 'sampling/createMessage' | 'elicitation/create';
      readonly decision: 'approve' | 'decline' | 'cancel';
    })
  | (EventBase & {
      readonly type: 'mcp-task-updated';
      readonly serverId: string;
      readonly taskId: string;
      readonly toolName: string;
      readonly status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
    })
  | (EventBase & {
      readonly type: 'execution-error';
      readonly code: string;
      readonly message: string;
      readonly details: JsonValue;
    })
  | (EventBase & {
      readonly type: 'execution-finished';
      readonly status: Extract<ExecutionStatus, 'completed' | 'cancelled' | 'failed'>;
    })
  | (EventBase & { readonly type: 'execution-interrupted'; readonly reason: string });
