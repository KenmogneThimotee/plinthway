import {
  asEventId,
  asExecutionId,
  asProfileId,
  asSessionId,
  type EffectiveProfile,
  type ExecutionEvent,
  type SessionId,
} from '@plinthway/shared';

export function snapshot(id = 'coding'): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId(id),
    name: id,
    model: { primary: 'openai/test', fallback: [], parameters: {} },
    mcp: { enabled: [], roots: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist: true },
    resolvedMcpServers: [],
    resolvedProviders: {},
    generationId: `generation-${id}`,
  };
}

export function sessionId(value = 'session-a'): SessionId {
  return asSessionId(value);
}

export function event(
  index: number,
  type: 'user-message' | 'assistant-message' = 'user-message',
): ExecutionEvent {
  return {
    eventId: asEventId(`event-${String(index)}`),
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    type,
    content: `${type}-${String(index)}`,
  };
}

export function startedEvent(index = 1): ExecutionEvent {
  return {
    eventId: asEventId(`event-${String(index)}`),
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    type: 'execution-started',
    executionId: asExecutionId(`execution-${String(index)}`),
  };
}
