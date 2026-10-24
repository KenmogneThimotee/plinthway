import { describe, expect, it, vi } from 'vitest';

import { asProfileId, asSessionId, type EffectiveProfile, type LLMEvent } from '@plinthway/shared';
import { MemorySessionRepository } from '@plinthway/sessions';

import { SessionCoordinator } from './session-coordinator.js';

function profile(id = 'coding', persist = true, enabled: readonly string[] = []): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId(id),
    name: id,
    model: { primary: 'openai/primary', fallback: ['openai/fallback'], parameters: {} },
    mcp: { enabled: [...enabled], roots: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist },
    generationId: `generation-${id}`,
    resolvedMcpServers: [],
    resolvedProviders: {},
  };
}

async function* events(): AsyncGenerator<LLMEvent> {
  await Promise.resolve();
  yield { type: 'finish', reason: 'stop' };
}

describe('SessionCoordinator', () => {
  it('uses an explicit profile for one new session without changing active state', async () => {
    const durable = new MemorySessionRepository();
    const memory = new MemorySessionRepository();
    const active = profile();
    const coordinator = new SessionCoordinator({
      durable,
      memory,
      activeStore: { get: vi.fn().mockResolvedValue(active) },
      profiles: { resolve: vi.fn((id: string) => Promise.resolve(profile(id))) },
      engineFor: vi.fn(() => ({ run: events })),
      newSessionId: () => asSessionId('session-1'),
    });
    const created = await coordinator.newSession({ profileId: 'research' });
    expect(created.profile.id).toBe('research');
    expect(active.id).toBe('coding');
  });

  it('keeps non-persistent sessions out of the durable repository', async () => {
    const durable = new MemorySessionRepository();
    const memory = new MemorySessionRepository();
    const coordinator = new SessionCoordinator({
      durable,
      memory,
      activeStore: { get: vi.fn().mockResolvedValue(profile('scratch', false)) },
      profiles: { resolve: vi.fn() },
      engineFor: vi.fn(() => ({ run: events })),
      newSessionId: () => asSessionId('ephemeral-1'),
    });
    await coordinator.newSession();
    expect(await durable.list()).toEqual([]);
    expect(await memory.list()).toHaveLength(1);
  });

  it('resumes the immutable saved snapshot and offers safe recovery choices on setup failure', async () => {
    const durable = new MemorySessionRepository();
    await durable.create({ id: asSessionId('saved'), profile: profile('saved-profile') });
    const coordinator = new SessionCoordinator({
      durable,
      memory: new MemorySessionRepository(),
      activeStore: { get: vi.fn().mockResolvedValue(profile('current')) },
      profiles: { resolve: vi.fn().mockResolvedValue(profile('saved-profile')) },
      engineFor: vi.fn(() => ({ run: events })),
      prepareSnapshot: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(coordinator.resume(asSessionId('saved'))).resolves.toMatchObject({
      status: 'recovery-required',
      session: { profile: { id: 'saved-profile' } },
      choices: ['retry', 'read-only', 'branch'],
    });
  });

  it('does not reconnect MCP servers that were persistently disabled after a session was saved', async () => {
    const durable = new MemorySessionRepository();
    await durable.create({
      id: asSessionId('saved'),
      profile: profile('saved-profile', true, ['docs']),
    });
    const prepareSnapshot = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SessionCoordinator({
      durable,
      memory: new MemorySessionRepository(),
      activeStore: { get: vi.fn().mockResolvedValue(profile('saved-profile')) },
      profiles: { resolve: vi.fn() },
      currentMcpEnabled: vi.fn().mockResolvedValue([]),
      engineFor: vi.fn(() => ({ run: events })),
      prepareSnapshot,
    });

    await expect(coordinator.resume(asSessionId('saved'))).resolves.toMatchObject({
      status: 'recovery-required',
      error: { code: 'MCP_CONNECTION_FAILED' },
    });
    expect(prepareSnapshot).not.toHaveBeenCalled();
  });

  it('allows only primary or fallback model overrides', async () => {
    const coordinator = new SessionCoordinator({
      durable: new MemorySessionRepository(),
      memory: new MemorySessionRepository(),
      activeStore: { get: vi.fn().mockResolvedValue(profile()) },
      profiles: { resolve: vi.fn() },
      engineFor: vi.fn(() => ({ run: events })),
    });
    await expect(coordinator.newSession({ modelOverride: 'other/model' })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('branches without preparing dependencies again after an MCP-only transition', async () => {
    const durable = new MemorySessionRepository();
    await durable.create({ id: asSessionId('parent'), profile: profile() });
    const prepareSnapshot = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SessionCoordinator({
      durable,
      memory: new MemorySessionRepository(),
      activeStore: { get: vi.fn().mockResolvedValue(profile()) },
      profiles: { resolve: vi.fn().mockResolvedValue(profile()) },
      engineFor: vi.fn(() => ({ run: events })),
      prepareSnapshot,
      newSessionId: () => asSessionId('child'),
    });

    const child = await coordinator.branch(asSessionId('parent'), {
      profileId: 'coding',
      skipDependencyPreparation: true,
    });

    expect(child.id).toBe('child');
    expect(prepareSnapshot).not.toHaveBeenCalled();
  });

  it('continues an existing session instead of creating a replacement', async () => {
    const durable = new MemorySessionRepository();
    const savedId = asSessionId('saved');
    await durable.create({ id: savedId, profile: profile('saved-profile') });
    const run = vi.fn(events);
    const coordinator = new SessionCoordinator({
      durable,
      memory: new MemorySessionRepository(),
      activeStore: { get: vi.fn().mockResolvedValue(profile('current')) },
      profiles: { resolve: vi.fn() },
      engineFor: vi.fn(() => ({ run })),
    });

    const result = await coordinator.run('continue', { sessionId: savedId });
    for await (const event of result.events) expect(event.type).toBe('finish');

    expect(result.session.id).toBe(savedId);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: savedId, prompt: 'continue' }),
    );
    expect(await durable.list()).toHaveLength(1);
  });
});
