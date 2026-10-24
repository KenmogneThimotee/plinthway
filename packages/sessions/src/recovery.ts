import { newEventId, type SessionId } from '@plinthway/shared';

import type { SessionRepository } from './repository.js';

export interface InterruptedRecovery {
  readonly sessionId: SessionId;
  readonly pendingCallIds: readonly string[];
}

export async function recoverInterrupted(
  repository: SessionRepository,
  now: () => Date = () => new Date(),
): Promise<readonly InterruptedRecovery[]> {
  const recovered: InterruptedRecovery[] = [];
  for (const session of await repository.list()) {
    if (session.status !== 'running') continue;
    const events = await repository.events(session.id);
    const requested = new Set<string>();
    const completed = new Set<string>();
    for (const { event } of events) {
      if (event.type === 'tool-requested') requested.add(event.call.callId);
      if (event.type === 'tool-result') completed.add(event.callId);
    }
    const pendingCallIds = [...requested].filter((callId) => !completed.has(callId)).sort();
    const timestamp = now().toISOString();
    await repository.appendBatch(
      session.id,
      session.lastSequence,
      [
        {
          eventId: newEventId(),
          createdAt: timestamp,
          type: 'execution-interrupted',
          reason: 'process-restarted',
        },
      ],
      'interrupted',
    );
    recovered.push({ sessionId: session.id, pendingCallIds });
  }
  return recovered;
}
