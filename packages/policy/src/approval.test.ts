import { describe, expect, it, vi } from 'vitest';

import { asExecutionId, asSessionId } from '@plinthway/shared';

import { ApprovalBroker, invocationIdentity } from './approval.js';
import { ApprovalPromptRouter } from './approval-prompt.js';

function identity(argumentsValue: unknown = { path: '/tmp/a' }) {
  return invocationIdentity({
    sessionId: asSessionId('session-a'),
    executionId: asExecutionId('execution-a'),
    profileGenerationId: 'generation-a',
    callId: 'call-a',
    toolName: 'files.write',
    arguments: argumentsValue,
  });
}

describe('ApprovalBroker', () => {
  it('persists allow-once before issuing an exact single-use grant', async () => {
    const persisted: string[] = [];
    const broker = new ApprovalBroker({
      prompt: () => Promise.resolve('allow-once'),
      persist: (decision) => {
        persisted.push(decision.decision);
        return Promise.resolve();
      },
    });
    const invocation = identity();
    const outcome = await broker.request(invocation);
    expect(persisted).toEqual(['allow-once']);
    expect(outcome.decision).toBe('allow-once');
    if (outcome.decision !== 'allow-once') throw new Error('expected grant');
    expect(broker.consume(outcome.grant, invocation)).toBe(true);
    expect(broker.consume(outcome.grant, invocation)).toBe(false);
  });

  it('invalidates grants when arguments, session, execution, or generation changes', async () => {
    const broker = new ApprovalBroker({
      prompt: () => Promise.resolve('allow-once'),
      persist: () => Promise.resolve(),
    });
    const original = identity();
    const outcome = await broker.request(original);
    if (outcome.decision !== 'allow-once') throw new Error('expected grant');

    const changes = [
      identity({ path: '/tmp/b' }),
      { ...original, sessionId: asSessionId('session-b') },
      { ...original, executionId: asExecutionId('execution-b') },
      { ...original, profileGenerationId: 'generation-b' },
    ];
    for (const changed of changes) expect(broker.consume(outcome.grant, changed)).toBe(false);
    expect(broker.consume(outcome.grant, original)).toBe(true);
  });

  it('deduplicates concurrent decisions and returns a structured denial', async () => {
    const prompt = vi.fn(() => Promise.resolve<'deny'>('deny'));
    const persist = vi.fn(() => Promise.resolve());
    const broker = new ApprovalBroker({ prompt, persist });
    const invocation = identity();
    const [first, second] = await Promise.all([
      broker.request(invocation),
      broker.request(invocation),
    ]);
    expect(first).toMatchObject({ decision: 'deny', error: { code: 'TOOL_DENIED' } });
    expect(second).toEqual(first);
    expect(prompt).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not issue a grant when durable decision persistence fails', async () => {
    const broker = new ApprovalBroker({
      prompt: () => Promise.resolve('allow-once'),
      persist: () => Promise.reject(new Error('database unavailable')),
    });
    await expect(broker.request(identity())).rejects.toThrow('database unavailable');
  });

  it('invalidates outstanding grants after a profile generation change', async () => {
    const broker = new ApprovalBroker({
      prompt: vi.fn().mockResolvedValue('allow-once'),
      persist: vi.fn().mockResolvedValue(undefined),
    });
    const invocation = identity();
    const outcome = await broker.request(invocation);
    if (outcome.decision !== 'allow-once') throw new Error('expected grant');
    broker.invalidateAll();
    expect(broker.consume(outcome.grant, invocation)).toBe(false);
  });
});

describe('ApprovalPromptRouter', () => {
  it('routes an exact invocation to the active UI and reports persisted decisions', async () => {
    const router = new ApprovalPromptRouter(() => Promise.resolve('deny'));
    const prompt = vi.fn(() => Promise.resolve<'allow-once'>('allow-once'));
    const persisted = vi.fn();
    const dispose = router.attach({ prompt, persisted });
    const invocation = identity();
    const details = {
      identity: invocation,
      serverId: 'files',
      toolName: 'files.write',
      arguments: { path: '/tmp/a' },
      targets: ['/tmp/a'],
      readOnlyHint: false,
      sideEffects: 'may modify external state',
    } as const;

    await expect(router.request(details)).resolves.toBe('allow-once');
    router.decisionPersisted({ identity: invocation, decision: 'allow-once' });
    expect(prompt).toHaveBeenCalledWith(details);
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow-once' }));

    dispose();
    await expect(router.request(details)).resolves.toBe('deny');
  });
});
