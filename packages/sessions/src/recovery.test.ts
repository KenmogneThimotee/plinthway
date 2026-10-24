import { describe, expect, it } from 'vitest';

import { MemorySessionRepository } from './memory-repository.js';
import { recoverInterrupted } from './recovery.js';
import { event, sessionId, snapshot, startedEvent } from './test-helpers.js';

describe('recoverInterrupted', () => {
  it('terminalizes running sessions once and reports unresolved tool calls', async () => {
    const repository = new MemorySessionRepository();
    await repository.create({ id: sessionId(), profile: snapshot() });
    await repository.appendBatch(
      sessionId(),
      0,
      [
        startedEvent(),
        event(2),
        {
          eventId: 'event-3' as never,
          createdAt: '2026-01-01T00:00:03.000Z',
          type: 'tool-requested',
          call: { callId: 'call-1', toolName: 'files.write', input: {} },
        },
      ],
      'running',
    );
    const first = await recoverInterrupted(repository, () => new Date('2026-01-02T00:00:00.000Z'));
    expect(first).toEqual([{ sessionId: sessionId(), pendingCallIds: ['call-1'] }]);
    expect((await repository.get(sessionId())).status).toBe('interrupted');
    const eventsAfterFirst = await repository.events(sessionId());
    expect(eventsAfterFirst.at(-1)?.event.type).toBe('execution-interrupted');
    expect(await recoverInterrupted(repository)).toEqual([]);
    expect(await repository.events(sessionId())).toHaveLength(eventsAfterFirst.length);
  });
});
