import { describe, expect, it, vi } from 'vitest';

import type { TaskEnabledSession, ToolExecution } from '@modelcontextprotocol/ext-tasks/client';

import { McpTaskAdapter } from './task-adapter.js';

const TASK = {
  taskId: 'task-1',
  status: 'working' as const,
  createdAt: '2026-10-18T00:00:00.000Z',
  lastUpdatedAt: '2026-10-18T00:00:01.000Z',
  retentionMs: 60_000,
  suggestedPollIntervalMs: 250,
  ttl: 60_000,
  pollInterval: 250,
  raw: { taskId: 'task-1', status: 'working' as const },
  extensions: {},
};

function execution(kind: 'immediate' | 'task' = 'task'): ToolExecution<unknown> {
  const settle = vi.fn().mockResolvedValue({
    outcome: {
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] },
      task: { ...TASK, status: 'completed' },
    },
    lastTask: { ...TASK, status: 'completed' },
  });
  const value = {
    kind,
    ...(kind === 'task'
      ? {
          handle: { taskId: 'task-1', operation: 'tools/call' },
          serializeReference: () => ({
            endpointId: 'endpoint-1',
            generation: 'v2' as const,
            taskId: 'task-1',
            originalOperation: 'tools/call' as const,
          }),
        }
      : {}),
    applicationContext: undefined,
    declaration: undefined,
    updates: async function* () {
      await Promise.resolve();
      yield { type: 'task' as const, task: TASK };
    },
    result: vi.fn(),
    settle,
    cancel: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
  };
  return value as unknown as ToolExecution<unknown>;
}

describe('McpTaskAdapter', () => {
  it('opts eligible tool calls into tasks and preserves polymorphic immediate results', async () => {
    const immediate = execution('immediate');
    let receivedOptions: unknown;
    const callTool = vi.fn((_name: string, _params: unknown, options: unknown) => {
      receivedOptions = options;
      return Promise.resolve(immediate);
    });
    const session = {
      endpointId: 'endpoint-1',
      capabilities: {
        inventory: 'known-handles',
        execution: true,
        cancellation: true,
        inputResponses: true,
        requestedRetention: true,
      },
      callTool,
      close: vi.fn(),
    } as unknown as TaskEnabledSession;
    const adapter = new McpTaskAdapter(session);

    const started = await adapter.callTool(
      'report',
      { format: 'json' },
      { timeoutMs: 2_000 },
      {
        name: 'report',
        inputSchema: { type: 'object' },
        taskSupport: 'optional',
      },
    );
    expect(started.kind).toBe('immediate');
    expect(callTool).toHaveBeenCalledWith('report', { format: 'json' }, expect.any(Object));
    expect(receivedOptions).toMatchObject({
      task: { preference: 'allow' },
      requestTimeoutMs: 2_000,
      declaration: { taskSupport: 'optional' },
    });
    await expect(started.settle()).resolves.toMatchObject({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] },
    });
  });

  it('exposes durable references, status updates, cooperative cancellation, and mid-flight input', async () => {
    const taskExecution = execution('task');
    const updateJson = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const session = {
      endpointId: 'endpoint-1',
      capabilities: {
        inventory: 'known-handles',
        execution: true,
        cancellation: true,
        inputResponses: true,
        requestedRetention: true,
      },
      callTool: vi.fn().mockResolvedValue(taskExecution),
      task: vi.fn().mockReturnValue({
        snapshot: vi.fn().mockResolvedValue(TASK),
        updateJson,
        cancel,
      }),
      resumeTask: vi.fn().mockResolvedValue(taskExecution),
      close: vi.fn(),
    } as unknown as TaskEnabledSession;
    const adapter = new McpTaskAdapter(session);
    const started = await adapter.callTool(
      'report',
      {},
      { timeoutMs: 1_000 },
      { name: 'report', inputSchema: { type: 'object' }, taskSupport: 'required' },
    );
    expect(started.reference).toEqual({
      endpointId: 'endpoint-1',
      generation: 'v2',
      taskId: 'task-1',
      originalOperation: 'tools/call',
    });
    const updates = started.updates()[Symbol.asyncIterator]();
    await expect(updates.next()).resolves.toMatchObject({
      value: { type: 'task', task: { taskId: 'task-1', suggestedPollIntervalMs: 250 } },
    });

    await adapter.updateTask('task-1', { name: { action: 'accept', content: { input: 'Ada' } } });
    expect(updateJson).toHaveBeenCalledWith(
      { name: { action: 'accept', content: { input: 'Ada' } } },
      undefined,
    );
    await adapter.cancelTask('task-1');
    expect(cancel).toHaveBeenCalled();
  });
});
