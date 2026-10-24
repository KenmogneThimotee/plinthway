import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { LEGACY_HARNESS_MIGRATION_MARKER, migrateLegacyHarnessState } from './migration.js';
import { resolveLegacyHarnessPaths, resolvePlinthwayPaths } from './paths.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-migration-'));
  const env = {
    HARNESS_HOME: path.join(root, 'harness'),
    PLINTHWAY_HOME: path.join(root, 'plinthway'),
  };
  return {
    legacy: resolveLegacyHarnessPaths('linux', env, root),
    target: resolvePlinthwayPaths('linux', env, root),
  };
}

describe('migrateLegacyHarnessState', () => {
  it('copies legacy configuration, profiles, credentials, cache, and a consistent SQLite snapshot', async () => {
    const { legacy, target } = await fixture();
    await Promise.all([
      mkdir(path.dirname(legacy.config), { recursive: true }),
      mkdir(legacy.profiles, { recursive: true }),
      mkdir(legacy.data, { recursive: true }),
      mkdir(legacy.cache, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacy.config, 'schemaVersion: 1\n'),
      writeFile(path.join(legacy.profiles, 'work.yaml'), 'id: work\n'),
      writeFile(legacy.credentials, 'encrypted-credentials'),
      writeFile(legacy.chatgptAccounts, '{"connections":[]}\n'),
      writeFile(path.join(legacy.cache, 'catalog.json'), '{"models":[]}\n'),
    ]);
    const database = new DatabaseSync(legacy.database);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('CREATE TABLE legacy_state (value TEXT NOT NULL);');
    database.prepare('INSERT INTO legacy_state(value) VALUES (?)').run('preserved');

    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'migrated',
    });
    database.close();

    await expect(readFile(target.config, 'utf8')).resolves.toContain('schemaVersion: 1');
    await expect(readFile(path.join(target.profiles, 'work.yaml'), 'utf8')).resolves.toContain(
      'id: work',
    );
    await expect(readFile(target.credentials, 'utf8')).resolves.toBe('encrypted-credentials');
    await expect(readFile(path.join(target.cache, 'catalog.json'), 'utf8')).resolves.toContain(
      'models',
    );
    await expect(readFile(legacy.credentials, 'utf8')).resolves.toBe('encrypted-credentials');

    const migrated = new DatabaseSync(target.database, { readOnly: true });
    expect(migrated.prepare('SELECT value FROM legacy_state').get()).toEqual({
      value: 'preserved',
    });
    migrated.close();

    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'skipped-target-exists',
    });
  });

  it('never merges into or overwrites existing Plinthway state', async () => {
    const { legacy, target } = await fixture();
    await mkdir(path.dirname(legacy.config), { recursive: true });
    await mkdir(path.dirname(target.config), { recursive: true });
    await writeFile(legacy.config, 'legacy: true\n');
    await writeFile(target.config, 'plinthway: true\n');

    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'skipped-target-exists',
    });
    await expect(readFile(target.config, 'utf8')).resolves.toBe('plinthway: true\n');
  });

  it('does nothing when no legacy state exists', async () => {
    const { legacy, target } = await fixture();
    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'no-legacy-state',
    });
  });

  it('serializes concurrent first-run migrations without losing state', async () => {
    const { legacy, target } = await fixture();
    await mkdir(path.dirname(legacy.config), { recursive: true });
    await writeFile(legacy.config, 'schemaVersion: 1\n');

    const results = await Promise.all([
      migrateLegacyHarnessState({ legacy, target }),
      migrateLegacyHarnessState({ legacy, target }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      'migrated',
      'skipped-target-exists',
    ]);
    await expect(readFile(target.config, 'utf8')).resolves.toBe('schemaVersion: 1\n');
  });

  it('makes a late first-run process wait until every migrated path is published', async () => {
    const { legacy, target } = await fixture();
    await Promise.all([
      mkdir(path.dirname(legacy.config), { recursive: true }),
      mkdir(legacy.profiles, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacy.config, 'schemaVersion: 1\n'),
      writeFile(path.join(legacy.profiles, 'work.yaml'), 'id: work\n'),
    ]);

    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let firstPathPublished!: () => void;
    const firstPathWasPublished = new Promise<void>((resolve) => {
      firstPathPublished = resolve;
    });
    const first = migrateLegacyHarnessState({
      legacy,
      target,
      afterPublish: async (_destination: string, index: number) => {
        if (index !== 0) return;
        firstPathPublished();
        await publicationReleased;
      },
    });

    await Promise.race([
      firstPathWasPublished,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('migration did not expose its publication hook'));
        }, 250);
      }),
    ]);
    let secondSettled = false;
    const second = migrateLegacyHarnessState({ legacy, target }).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    releasePublication();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'migrated' }),
      expect.objectContaining({ status: 'skipped-target-exists' }),
    ]);
    await expect(readFile(path.join(target.profiles, 'work.yaml'), 'utf8')).resolves.toBe(
      'id: work\n',
    );
  });

  it('reclaims a lock whose owning process no longer exists', async () => {
    const { legacy, target } = await fixture();
    await mkdir(path.dirname(legacy.config), { recursive: true });
    await writeFile(legacy.config, 'schemaVersion: 1\n');
    const lockPath = path.join(path.dirname(target.config), '.plinthway-legacy-migration.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    const abandonedLock = `${JSON.stringify({
      pid: 2_147_483_647,
      token: 'abandoned-migration',
      createdAt: '2026-01-01T00:00:00.000Z',
    })}\n`;
    await writeFile(lockPath, abandonedLock);
    const fingerprint = createHash('sha256').update(abandonedLock).digest('hex').slice(0, 24);
    await link(lockPath, `${lockPath}.reclaim-${fingerprint}`);

    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'migrated',
    });
    await expect(readFile(target.config, 'utf8')).resolves.toBe('schemaVersion: 1\n');
  });

  it('recovers paths published by an interrupted migration before retrying', async () => {
    const { legacy, target } = await fixture();
    await Promise.all([
      mkdir(path.dirname(legacy.config), { recursive: true }),
      mkdir(legacy.profiles, { recursive: true }),
      mkdir(target.data, { recursive: true }),
      mkdir(target.profiles, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(legacy.config, 'schemaVersion: 1\n'),
      writeFile(path.join(legacy.profiles, 'work.yaml'), 'id: current\n'),
      writeFile(path.join(target.profiles, 'partial.yaml'), 'id: partial\n'),
      writeFile(
        path.join(target.data, LEGACY_HARNESS_MIGRATION_MARKER),
        `${JSON.stringify({
          schemaVersion: 1,
          source: 'Harness',
          migrationId: 'plinthway-migration-abandoned',
          state: 'preparing',
          migratedAt: '2026-01-01T00:00:00.000Z',
        })}\n`,
      ),
    ]);

    await expect(migrateLegacyHarnessState({ legacy, target })).resolves.toMatchObject({
      status: 'migrated',
    });
    await expect(readFile(path.join(target.profiles, 'work.yaml'), 'utf8')).resolves.toBe(
      'id: current\n',
    );
    await expect(
      readFile(path.join(target.profiles, 'partial.yaml'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
