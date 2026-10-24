import {
  toolDeclaration,
  type SerializedTaskReference,
  type TaskEnabledSession,
  type TaskExecutionEvent,
  type TaskOutcome,
  type TaskView,
  type ToolExecution,
} from '@modelcontextprotocol/ext-tasks/client';
import { taskId } from '@modelcontextprotocol/ext-tasks/core';

import { canonicalJson, PlinthwayError, type JsonValue } from '@plinthway/shared';

import type {
  McpCallOptions,
  McpTaskEvent,
  McpTaskExecution,
  McpTaskOutcome,
  McpTaskReference,
  McpTaskView,
  NativeMcpResult,
  NativeMcpTool,
} from './contracts.js';

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function jsonRecord(value: unknown, description: string): Readonly<Record<string, JsonValue>> {
  const normalized = asJson(value);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new PlinthwayError('MCP_PROTOCOL_ERROR', `${description} must be a JSON object`);
  }
  return normalized as Readonly<Record<string, JsonValue>>;
}

function nativeResult(value: unknown): NativeMcpResult {
  const result = jsonRecord(value, 'MCP task result');
  if (!Object.hasOwn(result, 'content')) {
    throw new PlinthwayError('MCP_PROTOCOL_ERROR', 'Completed MCP tool task has no content');
  }
  return {
    content: result.content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
    ...(result._meta === null || typeof result._meta !== 'object' || Array.isArray(result._meta)
      ? {}
      : { meta: result._meta as Readonly<Record<string, JsonValue>> }),
  };
}

export function normalizeTaskView(task: TaskView): McpTaskView {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
    ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    ...(task.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: task.lastUpdatedAt }),
    retentionMs: task.retentionMs,
    ...(task.suggestedPollIntervalMs === undefined
      ? {}
      : { suggestedPollIntervalMs: task.suggestedPollIntervalMs }),
    raw: jsonRecord(task.raw, 'MCP task snapshot'),
  };
}

function normalizeOutcome(outcome: TaskOutcome<unknown>): McpTaskOutcome {
  const normalizedTask = outcome.task === undefined ? undefined : normalizeTaskView(outcome.task);
  if (outcome.status === 'completed') {
    return {
      status: 'completed',
      result: nativeResult(outcome.result),
      ...(normalizedTask === undefined ? {} : { task: normalizedTask }),
    };
  }
  if (outcome.status === 'failed') {
    return {
      status: 'failed',
      error: {
        message: outcome.error.message,
        ...(outcome.error.code === undefined ? {} : { code: outcome.error.code }),
        ...(outcome.error.data === undefined ? {} : { data: outcome.error.data }),
      },
      ...(normalizedTask === undefined ? {} : { task: normalizedTask }),
    };
  }
  return {
    status: 'cancelled',
    ...(normalizedTask === undefined ? {} : { task: normalizedTask }),
  };
}

function normalizeEvent(event: TaskExecutionEvent<unknown>): McpTaskEvent {
  return event.type === 'task'
    ? { type: 'task', task: normalizeTaskView(event.task) }
    : { type: 'outcome', outcome: normalizeOutcome(event.outcome) };
}

function normalizeReference(reference: SerializedTaskReference): McpTaskReference {
  return {
    endpointId: reference.endpointId,
    generation: reference.generation,
    taskId: reference.taskId,
    originalOperation: reference.originalOperation,
  };
}

function taskExecution(execution: ToolExecution<unknown>): McpTaskExecution {
  const reference =
    execution.kind === 'task' ? normalizeReference(execution.serializeReference()) : undefined;
  return {
    kind: execution.kind,
    ...(reference === undefined ? {} : { reference }),
    updates: (signal?: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of execution.updates(signal)) yield normalizeEvent(event);
      },
    }),
    settle: async (options = {}) => {
      const settlement = await execution.settle({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvent === undefined
          ? {}
          : {
              onEvent: (event: TaskExecutionEvent<unknown>) =>
                options.onEvent?.(normalizeEvent(event)),
            }),
      });
      return normalizeOutcome(settlement.outcome);
    },
    cancel: (signal?: AbortSignal) => execution.cancel(signal),
    detach: () => execution.detach(),
    close: () => execution.close(),
  };
}

export class McpTaskAdapter {
  readonly #session: TaskEnabledSession;

  constructor(session: TaskEnabledSession) {
    this.#session = session;
  }

  get capabilities(): TaskEnabledSession['capabilities'] {
    return this.#session.capabilities;
  }

  async callTool(
    nativeName: string,
    argumentsValue: JsonValue,
    options: McpCallOptions,
    declaration: NativeMcpTool,
  ): Promise<McpTaskExecution> {
    const input = jsonRecord(argumentsValue, 'MCP tool arguments');
    const inputSchema = jsonRecord(declaration.inputSchema, 'MCP tool input schema');
    const execution = await this.#session.callTool(nativeName, input, {
      declaration: toolDeclaration({
        name: declaration.name,
        ...(declaration.title === undefined ? {} : { title: declaration.title }),
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
        inputSchema,
        ...(declaration.outputSchema === undefined
          ? {}
          : { outputSchema: jsonRecord(declaration.outputSchema, 'MCP tool output schema') }),
        ...(declaration.taskSupport === undefined ? {} : { taskSupport: declaration.taskSupport }),
      }),
      task: {
        preference:
          declaration.taskSupport === 'required'
            ? 'require'
            : declaration.taskSupport === 'forbidden'
              ? 'forbid'
              : 'allow',
      },
      requestTimeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return taskExecution(execution);
  }

  async getTask(taskIdValue: string, signal?: AbortSignal): Promise<McpTaskView> {
    return normalizeTaskView(await this.#session.task(taskId(taskIdValue)).snapshot(signal));
  }

  updateTask(
    taskIdValue: string,
    inputResponses: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#session.task(taskId(taskIdValue)).updateJson(inputResponses, signal);
  }

  cancelTask(taskIdValue: string, signal?: AbortSignal): Promise<void> {
    return this.#session.task(taskId(taskIdValue)).cancel(signal);
  }

  async resumeTask(
    reference: McpTaskReference,
    options: McpCallOptions,
  ): Promise<McpTaskExecution> {
    const execution = await this.#session.resumeTask(reference as SerializedTaskReference, {
      requestTimeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return taskExecution(execution);
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}
