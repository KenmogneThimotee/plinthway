import { describe, expect, it, vi } from 'vitest';

import { asProfileId, PlinthwayError, type EffectiveProfile } from '@plinthway/shared';

import { SwitchCoordinator } from './switch-coordinator.js';

function profile(id: string, generation = id): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId(id),
    name: id,
    model: { primary: 'openai/test', fallback: [], parameters: {} },
    mcp: { enabled: ['files'], roots: [] },
    tools: { defaultPolicy: 'deny', rules: [{ tool: 'files.read', action: 'allow' }] },
    agent: { maxSteps: 5 },
    session: { persist: true },
    generationId: generation,
    resolvedMcpServers: [],
    resolvedProviders: {},
  };
}

function fixture(
  options: {
    readonly commitFails?: boolean;
    readonly busy?: boolean;
    readonly tools?: readonly { readonly name: string }[];
  } = {},
) {
  let active: EffectiveProfile | undefined = profile('coding');
  const prepared = {
    tools: options.tools ?? [{ name: 'files.read' }],
    commit: options.commitFails
      ? vi.fn().mockRejectedValue(new PlinthwayError('MCP_CONNECTION_FAILED', 'failed'))
      : vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    releaseSuperseded: vi.fn().mockResolvedValue(undefined),
  };
  const transitions = {
    begin: vi.fn().mockResolvedValue({ id: 'transition-1' }),
    commitWithActiveProfile: vi.fn((_id: string, target: EffectiveProfile) => {
      active = target;
      return Promise.resolve();
    }),
    rollback: vi.fn().mockResolvedValue(undefined),
    compensate: vi.fn((_id: string, previous: EffectiveProfile | undefined) => {
      active = previous;
      return Promise.resolve();
    }),
    list: vi.fn().mockResolvedValue([]),
  };
  const coordinator = new SwitchCoordinator({
    profiles: { resolve: vi.fn((id: string) => Promise.resolve(profile(id))) },
    activeStore: {
      get: vi.fn(() => Promise.resolve(active)),
      clear: vi.fn(() => {
        active = undefined;
        return Promise.resolve();
      }),
    },
    dependencies: { prepare: vi.fn().mockResolvedValue(prepared) },
    executionGate: { quiesce: vi.fn().mockResolvedValue(!options.busy) },
    transitions,
    approvals: { invalidateAll: vi.fn() },
  });
  return { coordinator, prepared, transitions, active: () => active };
}

describe('SwitchCoordinator', () => {
  it('prepares, atomically activates, invalidates grants, and releases superseded handles', async () => {
    const { coordinator, prepared, transitions, active } = fixture();
    await expect(coordinator.switchProfile('research', { onBusy: 'wait' })).resolves.toMatchObject({
      id: 'research',
    });
    expect(transitions.commitWithActiveProfile).toHaveBeenCalledOnce();
    expect(prepared.commit).toHaveBeenCalledOnce();
    expect(prepared.releaseSuperseded).toHaveBeenCalledOnce();
    expect(active()?.id).toBe('research');
    expect(coordinator.state).toBe('ACTIVE');
  });

  it('restores the previous active snapshot when prepared activation fails', async () => {
    const { coordinator, prepared, transitions, active } = fixture({ commitFails: true });
    await expect(coordinator.switchProfile('research', { onBusy: 'wait' })).rejects.toMatchObject({
      code: 'MCP_CONNECTION_FAILED',
    });
    expect(prepared.rollback).toHaveBeenCalledOnce();
    expect(transitions.compensate).toHaveBeenCalledOnce();
    expect(active()?.id).toBe('coding');
  });

  it('does not mutate active state when cancellation is declined', async () => {
    const { coordinator, prepared, transitions, active } = fixture({ busy: true });
    await expect(coordinator.switchProfile('research', { onBusy: 'cancel' })).rejects.toMatchObject(
      {
        code: 'CANCELLED',
      },
    );
    expect(prepared.rollback).toHaveBeenCalledOnce();
    expect(transitions.begin).not.toHaveBeenCalled();
    expect(active()?.id).toBe('coding');
  });

  it('activates when configured tools are temporarily unavailable', async () => {
    const { coordinator, prepared, transitions } = fixture({ tools: [] });
    await expect(coordinator.switchProfile('research', { onBusy: 'wait' })).resolves.toMatchObject({
      id: 'research',
    });
    expect(prepared.rollback).not.toHaveBeenCalled();
    expect(transitions.begin).toHaveBeenCalledOnce();
  });
});
