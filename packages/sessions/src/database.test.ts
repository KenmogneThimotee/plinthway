import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeStatement, SessionDatabase } from './database.js';
import { INITIAL_MIGRATION } from './migrations.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SessionDatabase', () => {
  it('supports Node 24 releases where StatementSync has no explicit close method', () => {
    expect(() => closeStatement({})).not.toThrow();
    const close = vi.fn();
    closeStatement({ close });
    expect(close).toHaveBeenCalledOnce();
  });

  it('migrates fresh databases, configures safety pragmas, and reopens idempotently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-db-'));
    roots.push(root);
    const databasePath = path.join(root, 'data', 'sessions.sqlite');
    const first = new SessionDatabase(databasePath);
    expect(first.pragmas()).toMatchObject({
      foreignKeys: true,
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
    });
    expect(first.migrationVersion()).toBe(5);
    first.close();

    const reopened = new SessionDatabase(databasePath);
    expect(reopened.migrationVersion()).toBe(5);
    reopened.close();
  });

  it('upgrades the historical version-one schema with profile selection and MCP tasks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-db-v1-'));
    roots.push(root);
    const databasePath = path.join(root, 'sessions.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      ${INITIAL_MIGRATION}
      DROP TABLE selected_profile;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const upgraded = new SessionDatabase(databasePath);
    expect(upgraded.migrationVersion()).toBe(5);
    const tables = upgraded.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mcp_tasks', 'selected_profile') ORDER BY name",
      )
      .all();
    expect(tables).toEqual([{ name: 'mcp_tasks' }, { name: 'selected_profile' }]);
    upgraded.close();
  });
});
