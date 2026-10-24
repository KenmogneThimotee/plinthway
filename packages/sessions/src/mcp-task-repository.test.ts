import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionDatabase } from './database.js';
import { SqliteMcpTaskRepository } from './mcp-task-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteMcpTaskRepository', () => {
  it('keeps identical server task IDs isolated by profile generation', async () => {
    const database = new SessionDatabase(':memory:');
    const repository = new SqliteMcpTaskRepository(database);
    const task = {
      serverId: 'reports',
      toolName: 'reports.generate',
      reference: {
        endpointId: 'endpoint-a',
        generation: 'v2' as const,
        taskId: 'task-1',
        originalOperation: 'tools/call',
      },
      status: 'working' as const,
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:01.000Z',
    };

    await repository.upsert({ ...task, profileGenerationId: 'generation-a' });
    await repository.upsert({ ...task, profileGenerationId: 'generation-b' });

    await expect(repository.get('reports', 'task-1', 'generation-a')).resolves.toMatchObject({
      profileGenerationId: 'generation-a',
    });
    await expect(repository.get('reports', 'task-1', 'generation-b')).resolves.toMatchObject({
      profileGenerationId: 'generation-b',
    });
    await expect(repository.list()).resolves.toHaveLength(2);
    database.close();
  });

  it('survives restart and scopes resumable references to a profile generation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-tasks-'));
    roots.push(root);
    const databasePath = path.join(root, 'sessions.sqlite');
    const firstDatabase = new SessionDatabase(databasePath);
    const first = new SqliteMcpTaskRepository(firstDatabase);
    await first.upsert({
      serverId: 'reports',
      profileGenerationId: 'generation-a',
      toolName: 'reports.generate',
      reference: {
        endpointId: 'endpoint-a',
        generation: 'v2',
        taskId: 'task-1',
        originalOperation: 'tools/call',
      },
      status: 'working',
      task: {
        taskId: 'task-1',
        status: 'working',
        retentionMs: 60_000,
        suggestedPollIntervalMs: 250,
        raw: { taskId: 'task-1', status: 'working' },
      },
      result: {
        trusted: false,
        serverId: 'reports',
        toolName: 'reports.generate',
        content: [{ type: 'text', text: 'finished' }],
        isError: false,
      },
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:01.000Z',
      expiresAt: '2026-10-18T00:01:00.000Z',
    });
    firstDatabase.close();

    const secondDatabase = new SessionDatabase(databasePath);
    const second = new SqliteMcpTaskRepository(secondDatabase);
    const recovered = await second.list('generation-a');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.serverId).toBe('reports');
    expect(recovered[0]?.status).toBe('working');
    expect(recovered[0]?.reference).toMatchObject({ taskId: 'task-1', generation: 'v2' });
    expect(recovered[0]?.task?.suggestedPollIntervalMs).toBe(250);
    expect(recovered[0]?.result).toEqual({
      trusted: false,
      serverId: 'reports',
      toolName: 'reports.generate',
      content: [{ type: 'text', text: 'finished' }],
      isError: false,
    });
    await expect(second.list('generation-b')).resolves.toEqual([]);

    const stored = await second.get('reports', 'task-1', 'generation-a');
    if (stored === undefined) throw new Error('task was not recovered');
    await second.upsert({
      ...stored,
      status: 'completed',
      updatedAt: '2026-10-18T00:00:02.000Z',
    });
    await expect(second.get('reports', 'task-1', 'generation-a')).resolves.toMatchObject({
      status: 'completed',
    });
    secondDatabase.close();
  });
});
