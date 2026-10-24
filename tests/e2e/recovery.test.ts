import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  recoverInterrupted,
  SessionDatabase,
  SqliteSessionRepository,
} from '../../packages/sessions/src/index.js';
import {
  asEventId,
  asExecutionId,
  asProfileId,
  asSessionId,
  type EffectiveProfile,
} from '../../packages/shared/src/index.js';

const roots: string[] = [];

function profile(): EffectiveProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('coding'),
    name: 'Coding',
    model: { primary: 'local/test', fallback: [], parameters: {} },
    mcp: { enabled: [], roots: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist: true },
    generationId: 'generation-coding',
    resolvedMcpServers: [],
    resolvedProviders: {},
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('process restart recovery', () => {
  it('reopens SQLite and identifies an interrupted pending tool call', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-recovery-'));
    roots.push(root);
    const file = path.join(root, 'plinthway.sqlite');
    const sessionId = asSessionId('session-restart');
    const first = new SessionDatabase(file);
    const before = new SqliteSessionRepository(first);
    await before.create({ id: sessionId, profile: profile() });
    await before.appendBatch(
      sessionId,
      0,
      [
        {
          eventId: asEventId('event-start'),
          createdAt: new Date(0).toISOString(),
          type: 'execution-started',
          executionId: asExecutionId('execution-restart'),
        },
        {
          eventId: asEventId('event-tool'),
          createdAt: new Date(0).toISOString(),
          type: 'tool-requested',
          call: { callId: 'pending-call', toolName: 'files.read', input: { path: '/tmp/a' } },
        },
      ],
      'running',
    );
    first.close();

    const second = new SessionDatabase(file);
    try {
      const after = new SqliteSessionRepository(second);
      await expect(recoverInterrupted(after, () => new Date(1))).resolves.toEqual([
        { sessionId, pendingCallIds: ['pending-call'] },
      ]);
      expect((await after.get(sessionId)).status).toBe('interrupted');
    } finally {
      second.close();
    }
  });
});
