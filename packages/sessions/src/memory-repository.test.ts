import { describe, expect, it } from 'vitest';

import { asEventId } from '@plinthway/shared';

import { MemorySessionRepository } from './memory-repository.js';
import { event, sessionId, snapshot } from './test-helpers.js';

describe('MemorySessionRepository', () => {
  it('matches sequencing and ancestry-aware reconstruction without durable listing', async () => {
    const durableList: readonly unknown[] = [];
    const repository = new MemorySessionRepository();
    await repository.create({ id: sessionId('parent'), profile: snapshot() });
    await repository.appendBatch(sessionId('parent'), 0, [event(1), event(2, 'assistant-message')]);
    await repository.branch(sessionId('parent'), 1, {
      id: sessionId('child'),
      profile: snapshot('research'),
    });
    await repository.appendBatch(sessionId('child'), 0, [event(3)]);

    expect(
      (await repository.history(sessionId('child'))).map((entry) => entry.event.eventId),
    ).toEqual(['event-1', 'event-3']);
    expect(await repository.reconstructMessages(sessionId('child'))).toEqual([
      { role: 'user', content: 'user-message-1' },
      { role: 'user', content: 'user-message-3' },
    ]);
    expect(durableList).toEqual([]);
  });

  it('persists MCP provenance without injecting remote content into reconstructed chat', async () => {
    const repository = new MemorySessionRepository();
    await repository.create({ id: sessionId(), profile: snapshot() });
    await repository.appendBatch(sessionId(), 0, [
      {
        eventId: asEventId('event-prompt'),
        createdAt: '2026-01-01T00:00:00.000Z',
        type: 'mcp-prompt-used',
        serverId: 'docs',
        promptName: 'docs.summarize',
        argumentNames: ['style'],
      },
      {
        eventId: asEventId('event-resource'),
        createdAt: '2026-01-01T00:00:01.000Z',
        type: 'mcp-resource-attached',
        serverId: 'docs',
        uri: 'docs://guide',
        mimeTypes: ['text/plain'],
      },
      {
        eventId: asEventId('event-task'),
        createdAt: '2026-01-01T00:00:02.000Z',
        type: 'mcp-task-updated',
        serverId: 'docs',
        taskId: 'task-1',
        toolName: 'docs.report',
        status: 'input_required',
      },
    ]);

    expect(await repository.reconstructMessages(sessionId())).toEqual([]);
    expect(await repository.events(sessionId())).toHaveLength(3);
  });
});
