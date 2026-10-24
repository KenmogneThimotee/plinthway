import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { registerRedactionSecret } from '@plinthway/shared';

import { SessionDatabase } from './database.js';
import { SqliteSessionRepository } from './repository.js';
import { event, sessionId, snapshot } from './test-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly path: string;
  readonly database: SessionDatabase;
  readonly repository: SqliteSessionRepository;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-sessions-'));
  roots.push(root);
  const databasePath = path.join(root, 'sessions.sqlite');
  const database = new SessionDatabase(databasePath);
  return { path: databasePath, database, repository: new SqliteSessionRepository(database) };
}

describe('SqliteSessionRepository', () => {
  it('persists ordered batches with optimistic sequencing and durable reopen', async () => {
    const { path: databasePath, database, repository } = await fixture();
    await repository.create({ id: sessionId(), profile: snapshot() });
    const appended = await repository.appendBatch(
      sessionId(),
      0,
      [event(1), event(2, 'assistant-message')],
      'completed',
    );
    expect(appended.lastSequence).toBe(2);
    await expect(repository.appendBatch(sessionId(), 0, [event(3)])).rejects.toMatchObject({
      code: 'SESSION_CONFLICT',
    });
    database.close();

    const reopened = new SessionDatabase(databasePath);
    const durable = new SqliteSessionRepository(reopened);
    expect((await durable.get(sessionId())).status).toBe('completed');
    expect((await durable.events(sessionId())).map((entry) => entry.sequence)).toEqual([1, 2]);
    reopened.close();
  });

  it('rolls back the whole batch when any event insert fails', async () => {
    const { database, repository } = await fixture();
    await repository.create({ id: sessionId(), profile: snapshot() });
    const duplicate = event(1);
    await expect(
      repository.appendBatch(sessionId(), 0, [duplicate, duplicate]),
    ).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    expect((await repository.get(sessionId())).lastSequence).toBe(0);
    expect(await repository.events(sessionId())).toEqual([]);
    database.close();
  });

  it('rejects registered secrets before persistence', async () => {
    const { database, repository } = await fixture();
    await repository.create({ id: sessionId(), profile: snapshot() });
    const unregister = registerRedactionSecret('credential-canary');
    try {
      const secretEvent = event(1);
      if (secretEvent.type !== 'user-message') throw new Error('expected user message');
      await expect(
        repository.appendBatch(sessionId(), 0, [{ ...secretEvent, content: 'credential-canary' }]),
      ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      expect(await repository.events(sessionId())).toEqual([]);
    } finally {
      unregister();
      database.close();
    }
  });

  it('detects snapshot corruption instead of silently repairing it', async () => {
    const { path: databasePath, database, repository } = await fixture();
    await repository.create({ id: sessionId(), profile: snapshot() });
    database.close();
    const tamper = new DatabaseSync(databasePath);
    tamper
      .prepare('UPDATE sessions SET profile_snapshot_json = ? WHERE id = ?')
      .run('{}', sessionId());
    tamper.close();

    const reopened = new SessionDatabase(databasePath);
    const corrupted = new SqliteSessionRepository(reopened);
    await expect(corrupted.get(sessionId())).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    reopened.close();
  });

  it('enforces parent foreign keys and returns sessions in updated order', async () => {
    const { database, repository } = await fixture();
    await repository.create({ id: sessionId('a'), profile: snapshot() });
    await repository.create({ id: sessionId('b'), profile: snapshot('research') });
    await expect(
      repository.branch(sessionId('missing'), 0, { id: sessionId('child'), profile: snapshot() }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(
      repository.create({
        id: sessionId('orphan'),
        parentSessionId: sessionId('missing'),
        branchFromSequence: 0,
        profile: snapshot(),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect((await repository.list()).map((session) => session.id)).toEqual(['b', 'a']);
    database.close();
  });

  it('reconstructs branch history without copying parent rows', async () => {
    const { database, repository } = await fixture();
    await repository.create({ id: sessionId('parent'), profile: snapshot() });
    await repository.appendBatch(sessionId('parent'), 0, [event(1), event(2)], 'completed');
    await repository.branch(sessionId('parent'), 1, {
      id: sessionId('child'),
      profile: snapshot('research'),
    });
    await repository.appendBatch(sessionId('child'), 0, [event(3)], 'completed');

    expect(
      (await repository.history(sessionId('child'))).map((entry) => entry.event.eventId),
    ).toEqual([event(1).eventId, event(3).eventId]);
    expect(await repository.events(sessionId('child'))).toHaveLength(1);
    database.close();
  });
});
