import { describe, expect, it, vi } from 'vitest';

import { asExecutionId, asSessionId, PlinthwayError, type ToolCall } from '@plinthway/shared';
import { ApprovalBroker, PolicyEngine } from '@plinthway/policy';

import { ToolRunner } from './tool-runner.js';

const call: ToolCall = { callId: 'call-1', toolName: 'shell.run', input: { command: 'pwd' } };

function policy(action: 'allow' | 'ask' | 'deny'): PolicyEngine {
  return new PolicyEngine({
    enabledServers: ['shell'],
    defaultPolicy: 'deny',
    rules: [{ tool: 'shell.run', action }],
    tools: [{ name: 'shell.run', serverId: 'shell', annotations: { readOnlyHint: false } }],
  });
}

describe('ToolRunner', () => {
  it('applies provider risk floors before deciding whether approval is required', async () => {
    const prompt = vi.fn().mockResolvedValue('deny');
    const invoke = vi.fn();
    const runner = new ToolRunner({
      policy: new PolicyEngine({
        enabledServers: [],
        defaultPolicy: 'deny',
        rules: [],
        tools: [
          {
            name: 'filesystem.read_text',
            source: { kind: 'builtin', id: 'filesystem' },
            annotations: { readOnlyHint: true },
            intrinsicAction: 'allow',
          },
        ],
      }),
      approvals: new ApprovalBroker({ prompt, persist: vi.fn() }),
      mcp: {
        invoke,
        listTools: () => [
          {
            name: 'filesystem.read_text',
            serverId: 'filesystem',
            annotations: { readOnlyHint: true },
          },
        ],
        describeInvocation: () =>
          Promise.resolve({
            targets: ['/workspace/.env'],
            readOnlyHint: true,
            sideEffects: 'may disclose sensitive workspace contents',
            riskFloor: 'ask' as const,
          }),
      },
      sessionId: asSessionId('session-1'),
      executionId: asExecutionId('execution-1'),
      profileGenerationId: 'generation-1',
      timeoutMs: 100,
    });

    await expect(
      runner.run(
        {
          callId: 'call-sensitive',
          toolName: 'filesystem.read_text',
          input: { path: '.env' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ decision: { action: 'ask', reason: 'risk-floor' } });
    expect(prompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targets: ['/workspace/.env'],
        sideEffects: 'may disclose sensitive workspace contents',
      }),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns a denial to the model without invoking MCP', async () => {
    const invoke = vi.fn();
    const runner = new ToolRunner({
      policy: policy('deny'),
      approvals: new ApprovalBroker({ prompt: vi.fn(), persist: vi.fn() }),
      mcp: {
        invoke,
        listTools: () => [
          { name: 'shell.run', serverId: 'shell', annotations: { readOnlyHint: false } },
        ],
      },
      sessionId: asSessionId('session-1'),
      executionId: asExecutionId('execution-1'),
      profileGenerationId: 'generation-1',
      timeoutMs: 100,
    });
    const result = await runner.run(call, new AbortController().signal);
    expect(result.decision.action).toBe('deny');
    expect(result.result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('consumes approval only for the exact invocation identity', async () => {
    const invoke = vi.fn().mockResolvedValue({
      trusted: false,
      serverId: 'shell',
      toolName: 'shell.run',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    const prompt = vi.fn().mockResolvedValue('allow-once');
    const runner = new ToolRunner({
      policy: policy('ask'),
      approvals: new ApprovalBroker({ prompt, persist: vi.fn() }),
      mcp: {
        invoke,
        listTools: () => [
          { name: 'shell.run', serverId: 'shell', annotations: { readOnlyHint: false } },
        ],
      },
      sessionId: asSessionId('session-1'),
      executionId: asExecutionId('execution-1'),
      profileGenerationId: 'generation-1',
      timeoutMs: 100,
    });
    await expect(runner.run(call, new AbortController().signal)).resolves.toMatchObject({
      result: { isError: false },
      approvalDecision: 'allow-once',
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'shell.run' }),
      expect.objectContaining({
        serverId: 'shell',
        toolName: 'shell.run',
        arguments: { command: 'pwd' },
        readOnlyHint: false,
        sideEffects: 'may modify external state',
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('maps tool timeouts to an untrusted error result', async () => {
    const runner = new ToolRunner({
      policy: policy('allow'),
      approvals: new ApprovalBroker({ prompt: vi.fn(), persist: vi.fn() }),
      mcp: {
        invoke: vi.fn().mockRejectedValue(new PlinthwayError('TIMEOUT', 'tool timed out')),
      },
      sessionId: asSessionId('session-1'),
      executionId: asExecutionId('execution-1'),
      profileGenerationId: 'generation-1',
      timeoutMs: 100,
    });
    await expect(runner.run(call, new AbortController().signal)).resolves.toMatchObject({
      result: { isError: true, content: { code: 'TIMEOUT' } },
    });
  });

  it('returns invocation-description failures to the model without invoking the tool', async () => {
    const invoke = vi.fn();
    const runner = new ToolRunner({
      policy: policy('allow'),
      approvals: new ApprovalBroker({ prompt: vi.fn(), persist: vi.fn() }),
      mcp: {
        invoke,
        describeInvocation: vi
          .fn()
          .mockRejectedValue(new PlinthwayError('TOOL_ARGUMENTS_INVALID', 'path is required')),
      },
      sessionId: asSessionId('session-1'),
      executionId: asExecutionId('execution-1'),
      profileGenerationId: 'generation-1',
      timeoutMs: 100,
    });

    await expect(runner.run(call, new AbortController().signal)).resolves.toMatchObject({
      decision: { action: 'allow' },
      result: {
        isError: true,
        content: { code: 'TOOL_ARGUMENTS_INVALID', message: 'path is required' },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
