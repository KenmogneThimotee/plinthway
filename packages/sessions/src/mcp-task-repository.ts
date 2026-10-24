import type { McpPersistedTask, McpTaskRepositoryPort } from '@plinthway/mcp-client';
import { deepFreeze, PlinthwayError } from '@plinthway/shared';

import type { SessionDatabase } from './database.js';
import { serializeForPersistence } from './repository.js';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

function row(value: unknown): Row {
  if (value === undefined) throw new TypeError('Expected an MCP task row');
  return value as Row;
}

function parseTask(value: Row): McpPersistedTask {
  try {
    const reference = JSON.parse(String(value.reference_json)) as McpPersistedTask['reference'];
    const task =
      value.task_json === null
        ? undefined
        : (JSON.parse(String(value.task_json)) as NonNullable<McpPersistedTask['task']>);
    const result =
      value.result_json === null
        ? undefined
        : (JSON.parse(String(value.result_json)) as NonNullable<McpPersistedTask['result']>);
    const taskError =
      value.error_json === null
        ? undefined
        : (JSON.parse(String(value.error_json)) as NonNullable<McpPersistedTask['error']>);
    return deepFreeze({
      serverId: String(value.server_id),
      profileGenerationId: String(value.profile_generation_id),
      toolName: String(value.tool_name),
      reference,
      status: String(value.status) as McpPersistedTask['status'],
      ...(task === undefined ? {} : { task }),
      ...(result === undefined ? {} : { result }),
      ...(taskError === undefined ? {} : { error: taskError }),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
      ...(value.expires_at === null ? {} : { expiresAt: String(value.expires_at) }),
    });
  } catch (error) {
    throw new PlinthwayError('STORAGE_CORRUPT', 'Stored MCP task is invalid', {}, { cause: error });
  }
}

export class SqliteMcpTaskRepository implements McpTaskRepositoryPort {
  readonly #database: SessionDatabase;

  constructor(database: SessionDatabase) {
    this.#database = database;
  }

  async upsert(task: McpPersistedTask): Promise<void> {
    await Promise.resolve();
    serializeForPersistence(task);
    const statement = this.#database.connection.prepare(`
      INSERT INTO mcp_tasks(
        server_id, task_id, profile_generation_id, tool_name, reference_json, task_json,
        status, created_at, updated_at, expires_at, result_json, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_generation_id, server_id, task_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        reference_json = excluded.reference_json,
        task_json = excluded.task_json,
        status = excluded.status,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at,
        result_json = excluded.result_json,
        error_json = excluded.error_json
    `);
    try {
      statement.run(
        task.serverId,
        task.reference.taskId,
        task.profileGenerationId,
        task.toolName,
        serializeForPersistence(task.reference),
        task.task === undefined ? null : serializeForPersistence(task.task),
        task.status,
        task.createdAt,
        task.updatedAt,
        task.expiresAt ?? null,
        task.result === undefined ? null : serializeForPersistence(task.result),
        task.error === undefined ? null : serializeForPersistence(task.error),
      );
    } catch (error) {
      if (error instanceof PlinthwayError) throw error;
      throw new PlinthwayError('STORAGE_ERROR', 'Could not persist MCP task', {}, { cause: error });
    } finally {
      statement.close();
    }
  }

  async get(
    serverId: string,
    taskId: string,
    profileGenerationId: string,
  ): Promise<McpPersistedTask | undefined> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'SELECT * FROM mcp_tasks WHERE server_id = ? AND task_id = ? AND profile_generation_id = ?',
    );
    try {
      const value = statement.get(serverId, taskId, profileGenerationId);
      return value === undefined ? undefined : parseTask(row(value));
    } finally {
      statement.close();
    }
  }

  async list(profileGenerationId?: string): Promise<readonly McpPersistedTask[]> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      profileGenerationId === undefined
        ? 'SELECT * FROM mcp_tasks ORDER BY updated_at DESC, server_id, task_id'
        : 'SELECT * FROM mcp_tasks WHERE profile_generation_id = ? ORDER BY updated_at DESC, server_id, task_id',
    );
    try {
      const values =
        profileGenerationId === undefined ? statement.all() : statement.all(profileGenerationId);
      return values.map((value) => parseTask(row(value)));
    } finally {
      statement.close();
    }
  }

  async delete(serverId: string, taskId: string, profileGenerationId: string): Promise<void> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'DELETE FROM mcp_tasks WHERE server_id = ? AND task_id = ? AND profile_generation_id = ?',
    );
    try {
      statement.run(serverId, taskId, profileGenerationId);
    } finally {
      statement.close();
    }
  }
}
