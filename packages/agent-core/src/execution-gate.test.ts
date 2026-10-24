import { describe, expect, it, vi } from 'vitest';

import { asExecutionId } from '@plinthway/shared';

import { ExecutionGate } from './execution-gate.js';

describe('ExecutionGate', () => {
  it('cancels idempotently and resolves idle only after release', async () => {
    const gate = new ExecutionGate();
    const lease = gate.begin(asExecutionId('execution-1'));
    const idle = gate.waitForIdle();
    expect(gate.currentExecutionId).toBe('execution-1');
    expect(gate.cancel()).toBe(true);
    expect(gate.cancel()).toBe(false);
    expect(lease.signal.aborted).toBe(true);
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    lease.release();
    await expect(idle).resolves.toBeUndefined();
  });

  it('waits or asks before cancelling active work', async () => {
    const gate = new ExecutionGate();
    const lease = gate.begin(asExecutionId('execution-1'));
    const confirmCancel = vi.fn().mockResolvedValue(false);
    await expect(gate.quiesce({ onBusy: 'cancel', confirmCancel })).resolves.toBe(false);
    expect(lease.signal.aborted).toBe(false);
    const waiting = gate.quiesce({ onBusy: 'wait' });
    lease.release();
    await expect(waiting).resolves.toBe(true);
  });
});
