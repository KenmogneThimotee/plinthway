import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PlinthwayError } from '@plinthway/shared';

import {
  INITIAL_MIGRATION,
  MCP_TASK_OUTCOMES_MIGRATION,
  MCP_TASK_PROFILE_ISOLATION_MIGRATION,
  MCP_TASKS_MIGRATION,
  SELECTED_PROFILE_MIGRATION,
} from './migrations.js';

declare module 'node:sqlite' {
  interface StatementSync {
    close(): void;
  }
}

interface SqliteRow {
  readonly [key: string]: string | number | bigint | null;
}

function row(value: unknown): SqliteRow | undefined {
  return value as SqliteRow | undefined;
}

export class SessionDatabase {
  readonly connection: DatabaseSync;

  constructor(databasePath: string) {
    try {
      if (databasePath !== ':memory:')
        mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      this.connection = new DatabaseSync(databasePath, {
        timeout: 5_000,
        allowExtension: false,
        defensive: true,
      });
      this.connection.exec(
        'PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;',
      );
      if (databasePath !== ':memory:') this.connection.exec('PRAGMA journal_mode = WAL;');
      this.#migrate();
    } catch (error) {
      throw new PlinthwayError(
        'STORAGE_ERROR',
        'Could not open the session database',
        {},
        { cause: error },
      );
    }
  }

  #migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    let version = this.migrationVersion();
    if (version < 1) {
      this.#applyMigration(1, INITIAL_MIGRATION);
      version = 1;
    }
    if (version < 2) {
      this.#applyMigration(2, MCP_TASKS_MIGRATION);
      version = 2;
    }
    if (version < 3) {
      this.#applyMigration(3, MCP_TASK_OUTCOMES_MIGRATION);
      version = 3;
    }
    if (version < 4) {
      this.#applyMigration(4, MCP_TASK_PROFILE_ISOLATION_MIGRATION);
      version = 4;
    }
    if (version < 5) this.#applyMigration(5, SELECTED_PROFILE_MIGRATION);
  }

  #applyMigration(version: number, sql: string): void {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      this.connection.exec(sql);
      const statement = this.connection.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
      );
      try {
        statement.run(version, new Date().toISOString());
      } finally {
        statement.close();
      }
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  migrationVersion(): number {
    const statement = this.connection.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    try {
      return Number(row(statement.get())?.version ?? 0);
    } finally {
      statement.close();
    }
  }

  pragmas(): {
    readonly foreignKeys: boolean;
    readonly journalMode: string;
    readonly synchronous: number;
    readonly busyTimeout: number;
  } {
    const value = (name: string): string | number | bigint | null => {
      const statement = this.connection.prepare(`PRAGMA ${name}`);
      try {
        const result = row(statement.get());
        return result === undefined ? null : (Object.values(result)[0] ?? null);
      } finally {
        statement.close();
      }
    };
    return {
      foreignKeys: Number(value('foreign_keys')) === 1,
      journalMode: String(value('journal_mode')).toLowerCase(),
      synchronous: Number(value('synchronous')),
      busyTimeout: Number(value('busy_timeout')),
    };
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.connection.isOpen) this.connection.close();
  }
}
