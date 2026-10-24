import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { PlinthwayError } from '@plinthway/shared';

import type { PlinthwayPaths } from './paths.js';

export const LEGACY_HARNESS_MIGRATION_MARKER = '.migrated-from-harness.json';

export type LegacyStateMigrationStatus = 'migrated' | 'no-legacy-state' | 'skipped-target-exists';

export interface LegacyStateMigrationResult {
  readonly status: LegacyStateMigrationStatus;
  readonly marker?: string;
}

export interface MigrateLegacyHarnessStateOptions {
  readonly legacy: PlinthwayPaths;
  readonly target: PlinthwayPaths;
  readonly now?: () => Date;
  /** @internal Allows deterministic verification of concurrent publication. */
  readonly afterPublish?: (destination: string, index: number) => Promise<void>;
}

interface MigrationLockRecord {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

interface MigrationLock {
  readonly token: string;
  readonly assertOwner: () => Promise<void>;
  readonly release: () => Promise<void>;
}

const MALFORMED_LOCK_STALE_AFTER_MS = 30_000;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function anyExists(candidates: readonly string[]): Promise<boolean> {
  return (await Promise.all(candidates.map(exists))).some(Boolean);
}

function uniquePaths(paths: PlinthwayPaths): readonly string[] {
  return [...new Set([paths.config, paths.profiles, paths.data, paths.cache])];
}

function stagingPath(destination: string, migrationId: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${migrationId}.tmp`);
}

async function copyLegacyDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
}

function parseLockRecord(raw: string): MigrationLockRecord | undefined {
  try {
    const candidate = JSON.parse(raw) as Partial<MigrationLockRecord>;
    if (
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0 ||
      typeof candidate.token !== 'string' ||
      candidate.token.length === 0 ||
      typeof candidate.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      return undefined;
    }
    return candidate as MigrationLockRecord;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EINVAL') return false;
    return true;
  }
}

async function readLockRecord(
  lockPath: string,
): Promise<{ readonly raw: string; readonly record?: MigrationLockRecord } | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const record = parseLockRecord(raw);
    return record === undefined ? { raw } : { raw, record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
  const observed = await readLockRecord(lockPath);
  if (observed === undefined) return true;

  if (observed.record !== undefined) {
    if (processIsAlive(observed.record.pid)) return false;
  } else {
    const lockStat = await stat(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (lockStat === undefined || Date.now() - lockStat.mtimeMs < MALFORMED_LOCK_STALE_AFTER_MS) {
      return lockStat === undefined;
    }
  }

  const fingerprint = createHash('sha256').update(observed.raw).digest('hex').slice(0, 24);
  const claimPath = `${lockPath}.reclaim-${fingerprint}`;
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code !== 'EEXIST') throw error;
  }

  let current;
  let claim;
  try {
    [current, claim] = await Promise.all([
      stat(lockPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }),
      stat(claimPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }),
    ]);
  } catch (error) {
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }

  if (current === undefined) {
    await unlink(claimPath).catch(() => undefined);
    return true;
  }
  if (claim === undefined) return false;
  if (current.dev !== claim.dev || current.ino !== claim.ino) {
    await unlink(claimPath).catch(() => undefined);
    return false;
  }

  await unlink(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await unlink(claimPath).catch(() => undefined);
  return true;
}

async function acquireMigrationLock(target: PlinthwayPaths): Promise<MigrationLock> {
  const lockPath = path.join(path.dirname(target.config), '.plinthway-legacy-migration.lock');
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      const ownsLock = async (): Promise<boolean> => {
        const current = await readLockRecord(lockPath);
        return current?.record?.token === token;
      };
      return {
        token,
        assertOwner: async () => {
          if (!(await ownsLock())) {
            throw new PlinthwayError('STORAGE_ERROR', 'Legacy migration lock ownership was lost', {
              path: lockPath,
            });
          }
        },
        release: async () => {
          if (!(await ownsLock())) return;
          await unlink(lockPath).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimAbandonedLock(lockPath)) continue;
      await delay(25);
    }
  }
  throw new PlinthwayError(
    'STORAGE_ERROR',
    'Timed out waiting for another Plinthway process to finish legacy state migration',
    { path: lockPath },
  );
}

interface MigrationMarker {
  readonly schemaVersion: 1;
  readonly source: 'Harness';
  readonly migrationId: string;
  readonly state: 'preparing' | 'complete';
  readonly migratedAt: string;
}

async function readMigrationMarker(target: PlinthwayPaths): Promise<MigrationMarker | undefined> {
  const markerPath = path.join(target.data, LEGACY_HARNESS_MIGRATION_MARKER);
  try {
    const candidate = JSON.parse(await readFile(markerPath, 'utf8')) as Partial<MigrationMarker>;
    if (
      candidate.schemaVersion === 1 &&
      candidate.source === 'Harness' &&
      typeof candidate.migrationId === 'string' &&
      (candidate.state === 'preparing' || candidate.state === 'complete') &&
      typeof candidate.migratedAt === 'string'
    ) {
      return candidate as MigrationMarker;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function migrateLegacyHarnessState(
  options: MigrateLegacyHarnessStateOptions,
): Promise<LegacyStateMigrationResult> {
  const targetPaths = uniquePaths(options.target);
  const legacyPaths = uniquePaths(options.legacy);
  if (!(await anyExists(legacyPaths))) return { status: 'no-legacy-state' };

  const migrationLock = await acquireMigrationLock(options.target);
  try {
    const interruptedMarker = await readMigrationMarker(options.target);
    if (!(await exists(options.target.config)) && interruptedMarker?.state === 'preparing') {
      await Promise.all(
        [options.target.profiles, options.target.data, options.target.cache].map((destination) =>
          rm(destination, { recursive: true, force: true }),
        ),
      );
    }
    if (await anyExists(targetPaths)) return { status: 'skipped-target-exists' };
    if (!(await anyExists(legacyPaths))) return { status: 'no-legacy-state' };

    const migrationId = `plinthway-migration-${migrationLock.token}`;
    const staged: Array<{ readonly temporary: string; readonly destination: string }> = [];
    const installed: string[] = [];
    const stage = (destination: string): string => {
      const temporary = stagingPath(destination, migrationId);
      staged.push({ temporary, destination });
      return temporary;
    };

    try {
      if (await exists(options.legacy.config)) {
        const temporary = stage(options.target.config);
        await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
        await cp(options.legacy.config, temporary, { errorOnExist: true, force: false });
      }
      if (await exists(options.legacy.profiles)) {
        const temporary = stage(options.target.profiles);
        await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
        await cp(options.legacy.profiles, temporary, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }

      const temporaryData = stage(options.target.data);
      await mkdir(path.dirname(temporaryData), { recursive: true, mode: 0o700 });
      if (await exists(options.legacy.data)) {
        const legacyDatabase = options.legacy.database;
        await cp(options.legacy.data, temporaryData, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter(source) {
            return ![legacyDatabase, `${legacyDatabase}-shm`, `${legacyDatabase}-wal`].includes(
              source,
            );
          },
        });
      } else {
        await mkdir(temporaryData, { recursive: true, mode: 0o700 });
      }
      if (await exists(options.legacy.database)) {
        await copyLegacyDatabase(
          options.legacy.database,
          path.join(temporaryData, path.basename(options.target.database)),
        );
      }
      const marker = path.join(temporaryData, LEGACY_HARNESS_MIGRATION_MARKER);
      await writeFile(
        marker,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            source: 'Harness',
            migrationId,
            state: 'preparing',
            migratedAt: (options.now ?? (() => new Date()))().toISOString(),
          },
          null,
          2,
        )}\n`,
        { flag: 'wx', mode: 0o600 },
      );

      if (await exists(options.legacy.cache)) {
        const temporary = stage(options.target.cache);
        await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
        await cp(options.legacy.cache, temporary, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }

      if (await anyExists(targetPaths)) {
        throw new Error('Plinthway state appeared while legacy migration was being prepared');
      }
      const publicationOrder = [
        ...staged.filter(({ destination }) => destination === options.target.data),
        ...staged.filter(
          ({ destination }) =>
            destination !== options.target.data && destination !== options.target.config,
        ),
        ...staged.filter(({ destination }) => destination === options.target.config),
      ];
      for (const [index, item] of publicationOrder.entries()) {
        await migrationLock.assertOwner();
        await rename(item.temporary, item.destination);
        installed.push(item.destination);
        await options.afterPublish?.(item.destination, index);
      }
      await writeFile(
        path.join(options.target.data, LEGACY_HARNESS_MIGRATION_MARKER),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            source: 'Harness',
            migrationId,
            state: 'complete',
            migratedAt: (options.now ?? (() => new Date()))().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return {
        status: 'migrated',
        marker: path.join(options.target.data, LEGACY_HARNESS_MIGRATION_MARKER),
      };
    } catch (error) {
      await Promise.all([
        ...staged.map(({ temporary }) => rm(temporary, { recursive: true, force: true })),
        ...installed.map((destination) => rm(destination, { recursive: true, force: true })),
      ]);
      throw new PlinthwayError(
        'STORAGE_ERROR',
        'Could not migrate legacy Harness state to Plinthway',
        { source: options.legacy.data, target: options.target.data },
        { cause: error },
      );
    }
  } finally {
    await migrationLock.release();
  }
}
