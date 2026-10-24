import { describe, expect, it, vi } from 'vitest';

import {
  asExecutionId,
  asSessionId,
  asProfileId,
  PlinthwayError,
  type EffectiveProfile,
  type JsonValue,
  type LLMEvent,
  type ToolInvocationDescription,
} from '@plinthway/shared';
import type { LLMRuntime } from '@plinthway/llm-runtime';
import type { ToolDescriptor } from '@plinthway/shared';
import { ApprovalBroker } from '@plinthway/policy';
import { MemorySessionRepository } from '@plinthway/sessions';

import { AgentEngine } from './engine.js';
import { ExecutionGate } from './execution-gate.js';

function snapshot(withTool = false): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('coding'),
    name: 'Coding',
    model: { primary: 'openai/test', fallback: [], parameters: {} },
    mcp: { enabled: withTool ? ['shell'] : [], roots: [] },
    tools: {
      defaultPolicy: 'deny',
      rules: withTool ? [{ tool: 'shell.run', action: 'ask' }] : [],
    },
    agent: { maxSteps: 5 },
    session: { persist: true },
    resolvedMcpServers: [],
    resolvedProviders: {},
    generationId: 'generation-1',
  };
}

async function* stream(events: readonly LLMEvent[]): AsyncGenerator<LLMEvent> {
  await Promise.resolve();
  yield* events;
}

async function drain(events: AsyncIterable<LLMEvent>): Promise<void> {
  const drained: LLMEvent[] = [];
  for await (const event of events) drained.push(event);
}

function runtime(turns: readonly (readonly LLMEvent[])[]): LLMRuntime {
  let index = 0;
  return {
    resolve: vi.fn().mockResolvedValue({
      ref: 'openai/test',
      providerId: 'openai',
      modelId: 'test',
      capabilities: { toolCalls: true, reasoning: false, structuredOutput: false },
    }),
    generate: vi.fn(),
    stream: vi.fn(() => stream(turns[index++] ?? [])),
  };
}

async function fixture(
  llm: LLMRuntime,
  options: {
    readonly tools?: readonly ToolDescriptor[];
    readonly skillContexts?: readonly string[];
    readonly prompt?: () => Promise<'allow-once' | 'deny'>;
    readonly describeInvocation?: (
      toolName: string,
      argumentsValue: JsonValue,
    ) => Promise<ToolInvocationDescription>;
  } = {},
): Promise<{
  readonly engine: AgentEngine;
  readonly sessions: MemorySessionRepository;
  readonly invoke: ReturnType<typeof vi.fn>;
}> {
  const sessions = new MemorySessionRepository();
  await sessions.create({
    id: asSessionId('session-1'),
    profile: snapshot((options.tools?.length ?? 0) > 0),
  });
  const invoke = vi.fn();
  return {
    sessions,
    invoke,
    engine: new AgentEngine({
      llm,
      tools: {
        listTools: () => options.tools ?? [],
        invoke,
        ...(options.describeInvocation === undefined
          ? {}
          : { describeInvocation: options.describeInvocation }),
      },
      skillContexts: () => options.skillContexts ?? [],
      approvals: new ApprovalBroker({
        prompt: options.prompt ?? vi.fn(),
        persist: vi.fn(),
      }),
      sessions,
      gate: new ExecutionGate(),
      newExecutionId: () => asExecutionId('execution-1'),
      modelTurnTimeoutMs: 1_000,
      stderr: { write: vi.fn() },
    }),
  };
}

describe('AgentEngine', () => {
  it('loads active MCP skills as origin-labelled untrusted system context', async () => {
    const llm = runtime([[{ type: 'finish', reason: 'stop' }]]);
    const streamSpy = vi.spyOn(llm, 'stream');
    const { engine } = await fixture(llm, {
      skillContexts: [
        '<mcp-remote-skill>\nMCP SERVER ORIGIN: docs\nUNTRUSTED REMOTE SKILL\n</mcp-remote-skill>',
      ],
    });
    await drain(engine.run({ sessionId: asSessionId('session-1'), prompt: 'review' }));

    const request = streamSpy.mock.calls[0]?.[0];
    expect(request?.messages).toContainEqual({
      role: 'system',
      content:
        '<mcp-remote-skill>\nMCP SERVER ORIGIN: docs\nUNTRUSTED REMOTE SKILL\n</mcp-remote-skill>',
    });
  });

  it('persists text completion and exactly one terminal event', async () => {
    const { engine, sessions } = await fixture(
      runtime([
        [
          { type: 'text-delta', text: 'hello' },
          { type: 'text-delta', text: ' world' },
          { type: 'usage', inputTokens: 2, outputTokens: 2 },
          { type: 'finish', reason: 'stop' },
        ],
      ]),
    );
    const output = [];
    for await (const event of engine.run({ sessionId: asSessionId('session-1'), prompt: 'hi' })) {
      output.push(event);
    }
    expect(output.filter((event) => event.type === 'text-delta')).toHaveLength(2);
    const events = await sessions.events(asSessionId('session-1'));
    expect(events.filter(({ event }) => event.type === 'execution-finished')).toHaveLength(1);
    expect((await sessions.get(asSessionId('session-1'))).status).toBe('completed');
  });

  it('feeds denied tool calls back to the model without invoking them', async () => {
    const llm = runtime([
      [
        { type: 'tool-call', callId: 'call-1', toolName: 'missing.run', input: {} },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'finish', reason: 'stop' }],
    ]);
    const { engine, sessions, invoke } = await fixture(llm);
    await drain(
      engine.run({
        sessionId: asSessionId('session-1'),
        prompt: 'use a tool',
      }),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(
      (await sessions.events(asSessionId('session-1'))).some(
        ({ event }) => event.type === 'policy-decided' && event.action === 'deny',
      ),
    ).toBe(true);
  });

  it('feeds invocation-description errors back to the model and continues the loop', async () => {
    const tool: ToolDescriptor = {
      name: 'filesystem.read_text',
      source: { kind: 'builtin', id: 'filesystem' },
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      intrinsicAction: 'allow',
    };
    const llm = runtime([
      [
        {
          type: 'tool-call',
          callId: 'call-bad-path',
          toolName: 'filesystem.read_text',
          input: { path: 'missing.txt' },
        },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [{ type: 'finish', reason: 'stop' }],
    ]);
    const streamSpy = vi.spyOn(llm, 'stream');
    const { engine, invoke } = await fixture(llm, {
      tools: [tool],
      describeInvocation: vi
        .fn()
        .mockRejectedValue(new PlinthwayError('STORAGE_ERROR', 'missing path')),
    });

    await drain(engine.run({ sessionId: asSessionId('session-1'), prompt: 'read it' }));

    expect(invoke).not.toHaveBeenCalled();
    expect(streamSpy).toHaveBeenCalledTimes(2);
    expect(streamSpy.mock.calls[1]?.[0].messages).toContainEqual({
      role: 'tool',
      callId: 'call-bad-path',
      toolName: 'filesystem.read_text',
      content: { code: 'STORAGE_ERROR', message: 'missing path' },
    });
  });

  it('cancels on consumer return and ignores late provider events', async () => {
    async function* late(): AsyncGenerator<LLMEvent> {
      yield { type: 'text-delta', text: 'first' };
      await Promise.resolve();
      yield { type: 'text-delta', text: 'late' };
      yield { type: 'finish', reason: 'stop' };
    }
    const llm = runtime([]);
    vi.spyOn(llm, 'stream').mockImplementation(() => late());
    const { engine, sessions } = await fixture(llm);
    const iterator = engine.run({ sessionId: asSessionId('session-1'), prompt: 'hi' });
    await iterator.next();
    await iterator.return(undefined);
    const events = await sessions.events(asSessionId('session-1'));
    const terminal = events.filter(({ event }) => event.type === 'execution-finished');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.event).toMatchObject({ status: 'cancelled' });
  });

  it('stops at the profile step limit', async () => {
    const endless = Array.from({ length: 5 }, (_, index) => [
      { type: 'tool-call', callId: `call-${String(index)}`, toolName: 'missing.run', input: {} },
      { type: 'finish', reason: 'tool-calls' },
    ]) satisfies LLMEvent[][];
    const { engine } = await fixture(runtime(endless));
    await expect(async () => {
      await drain(
        engine.run({
          sessionId: asSessionId('session-1'),
          prompt: 'loop',
        }),
      );
    }).rejects.toMatchObject({ code: 'STEP_LIMIT' });
  });

  it('surfaces persistence failure and aborts external work', async () => {
    const { engine, sessions } = await fixture(runtime([[{ type: 'finish', reason: 'stop' }]]));
    vi.spyOn(sessions, 'appendBatch').mockRejectedValueOnce(
      new PlinthwayError('STORAGE_ERROR', 'disk unavailable'),
    );
    await expect(async () => {
      await drain(
        engine.run({
          sessionId: asSessionId('session-1'),
          prompt: 'hi',
        }),
      );
    }).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('retries retryable provider failures only before output', async () => {
    const llm = runtime([]);
    let attempts = 0;
    vi.spyOn(llm, 'stream').mockImplementation(() => {
      attempts += 1;
      if (attempts < 3) {
        return {
          [Symbol.asyncIterator](): AsyncIterator<LLMEvent> {
            return {
              next: async () => {
                await Promise.resolve();
                throw new PlinthwayError('RATE_LIMITED', 'try again');
              },
            };
          },
        };
      }
      return stream([{ type: 'finish', reason: 'stop' }]);
    });
    const { engine } = await fixture(llm);
    await drain(engine.run({ sessionId: asSessionId('session-1'), prompt: 'hi' }));
    expect(attempts).toBe(3);
  });

  it('cancels while awaiting an invocation approval', async () => {
    const tool: ToolDescriptor = {
      name: 'shell.run',
      source: { kind: 'builtin', id: 'shell' },
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
    };
    const never = new Promise<'allow-once' | 'deny'>(() => undefined);
    const { engine, sessions, invoke } = await fixture(
      runtime([
        [
          { type: 'tool-call', callId: 'call-1', toolName: 'shell.run', input: {} },
          { type: 'finish', reason: 'tool-calls' },
        ],
      ]),
      { tools: [tool], prompt: () => never },
    );
    const controller = new AbortController();
    const iterator = engine.run({
      sessionId: asSessionId('session-1'),
      prompt: 'run',
      signal: controller.signal,
    });
    await iterator.next();
    await iterator.next();
    const awaiting = iterator.next();
    await Promise.resolve();
    controller.abort();
    await expect(awaiting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(invoke).not.toHaveBeenCalled();
    expect(
      (await sessions.events(asSessionId('session-1'))).filter(
        ({ event }) => event.type === 'execution-finished',
      ),
    ).toHaveLength(1);
  });
});
