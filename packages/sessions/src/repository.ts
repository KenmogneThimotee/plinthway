import { randomUUID } from 'node:crypto';

import {
  asEventId,
  asExecutionId,
  asSessionId,
  canonicalJson,
  deepFreeze,
  PlinthwayError,
  redact,
  sha256,
  type EffectiveProfile,
  type ExecutionEvent,
  type ExecutionStatus,
  type LLMMessage,
  type SessionId,
} from '@plinthway/shared';

import type { SessionDatabase } from './database.js';

type SqlValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqlValue>;

export interface CreateSessionInput {
  readonly id: SessionId;
  readonly profile: EffectiveProfile;
  readonly modelOverride?: string;
  readonly parentSessionId?: SessionId;
  readonly branchFromSequence?: number;
}

export interface BranchSessionInput {
  readonly id: SessionId;
  readonly profile: EffectiveProfile;
  readonly modelOverride?: string;
}

export interface StoredSession {
  readonly id: SessionId;
  readonly parentSessionId?: SessionId;
  readonly branchFromSequence?: number;
  readonly profile: EffectiveProfile;
  readonly profileHash: string;
  readonly modelOverride?: string;
  readonly status: ExecutionStatus;
  readonly lastSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredSessionEvent {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly event: ExecutionEvent;
}

export interface SessionRepository {
  readonly create: (input: CreateSessionInput) => Promise<StoredSession>;
  readonly get: (id: SessionId) => Promise<StoredSession>;
  readonly list: () => Promise<readonly StoredSession[]>;
  readonly appendBatch: (
    id: SessionId,
    expectedSequence: number,
    events: readonly ExecutionEvent[],
    finalStatus?: ExecutionStatus,
  ) => Promise<StoredSession>;
  readonly events: (id: SessionId) => Promise<readonly StoredSessionEvent[]>;
  readonly history: (id: SessionId) => Promise<readonly StoredSessionEvent[]>;
  readonly reconstructMessages: (id: SessionId) => Promise<readonly LLMMessage[]>;
  readonly branch: (
    parentId: SessionId,
    atSequence: number,
    input: BranchSessionInput,
  ) => Promise<StoredSession>;
}

function storageError(message: string, cause?: unknown): PlinthwayError {
  return new PlinthwayError(
    'STORAGE_ERROR',
    message,
    {},
    cause === undefined ? undefined : { cause },
  );
}

export function serializeForPersistence(value: unknown): string {
  let original: string;
  let sanitized: string;
  try {
    original = canonicalJson(value);
    sanitized = canonicalJson(redact(value));
  } catch (error) {
    throw storageError('Value is not safe JSON for persistence', error);
  }
  if (original !== sanitized) {
    throw storageError('Sensitive data was rejected before persistence');
  }
  return sanitized;
}

function parseSnapshot(serialized: string, expectedHash: string): EffectiveProfile {
  if (sha256(serialized) !== expectedHash) {
    throw new PlinthwayError('STORAGE_CORRUPT', 'Stored profile snapshot hash does not match');
  }
  try {
    return deepFreeze(JSON.parse(serialized) as EffectiveProfile);
  } catch (error) {
    throw new PlinthwayError(
      'STORAGE_CORRUPT',
      'Stored profile snapshot is invalid',
      {},
      { cause: error },
    );
  }
}

function row(value: unknown): Row {
  if (value === undefined) throw new TypeError('Expected a SQLite row');
  return value as Row;
}

function optionalString(value: SqlValue | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function sessionFromRow(value: Row): StoredSession {
  const snapshotJson = String(value.profile_snapshot_json);
  const profileHash = String(value.profile_hash);
  return deepFreeze({
    id: asSessionId(String(value.id)),
    ...(optionalString(value.parent_session_id) === undefined
      ? {}
      : { parentSessionId: asSessionId(String(value.parent_session_id)) }),
    ...(value.branch_from_sequence === null || value.branch_from_sequence === undefined
      ? {}
      : { branchFromSequence: Number(value.branch_from_sequence) }),
    profile: parseSnapshot(snapshotJson, profileHash),
    profileHash,
    ...(optionalString(value.model_override) === undefined
      ? {}
      : { modelOverride: String(value.model_override) }),
    status: String(value.status) as ExecutionStatus,
    lastSequence: Number(value.last_sequence),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  });
}

function eventFromRow(value: Row): StoredSessionEvent {
  try {
    const parsed = JSON.parse(String(value.payload_json)) as ExecutionEvent;
    const event: ExecutionEvent = {
      ...parsed,
      eventId: asEventId(String(value.event_id)),
      createdAt: String(value.created_at),
    };
    if (event.type === 'execution-started') {
      (event as { executionId: ReturnType<typeof asExecutionId> }).executionId = asExecutionId(
        String(event.executionId),
      );
    }
    return deepFreeze({
      sessionId: asSessionId(String(value.session_id)),
      sequence: Number(value.sequence),
      event,
    });
  } catch (error) {
    throw new PlinthwayError(
      'STORAGE_CORRUPT',
      'Stored session event is invalid',
      {},
      { cause: error },
    );
  }
}

export function messagesFromEvents(events: readonly StoredSessionEvent[]): readonly LLMMessage[] {
  const messages: LLMMessage[] = [];
  for (const { event } of events) {
    if (event.type === 'user-message') messages.push({ role: 'user', content: event.content });
    else if (event.type === 'assistant-message') {
      messages.push({ role: 'assistant', content: event.content });
    } else if (event.type === 'tool-requested') {
      messages.push({ role: 'assistant', content: '', toolCalls: [event.call] });
    } else if (event.type === 'tool-result') {
      messages.push({
        role: 'tool',
        callId: event.callId,
        toolName: event.toolName,
        content: event.result,
      });
    }
  }
  return deepFreeze(messages);
}

export interface SqliteSessionRepositoryOptions {
  readonly now?: () => Date;
}

export class SqliteSessionRepository implements SessionRepository {
  readonly #database: SessionDatabase;
  readonly #now: () => Date;

  constructor(database: SessionDatabase, options: SqliteSessionRepositoryOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateSessionInput): Promise<StoredSession> {
    await Promise.resolve();
    serializeForPersistence(input);
    const snapshotJson = serializeForPersistence(input.profile);
    const profileHash = sha256(snapshotJson);
    const now = this.#now().toISOString();
    const statement = this.#database.connection.prepare(`
      INSERT INTO sessions(
        id, parent_session_id, branch_from_sequence, profile_id, profile_generation_id,
        profile_snapshot_json, profile_hash, model_override, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
    `);
    try {
      statement.run(
        input.id,
        input.parentSessionId ?? null,
        input.branchFromSequence ?? null,
        input.profile.id,
        input.profile.generationId,
        snapshotJson,
        profileHash,
        input.modelOverride ?? null,
        now,
        now,
      );
    } catch (error) {
      throw storageError(`Could not create session ${input.id}`, error);
    } finally {
      statement.close();
    }
    return this.get(input.id);
  }

  async get(id: SessionId): Promise<StoredSession> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare('SELECT * FROM sessions WHERE id = ?');
    try {
      const value = statement.get(id);
      if (value === undefined) {
        throw new PlinthwayError('SESSION_NOT_FOUND', `Session ${id} was not found`, {
          sessionId: id,
        });
      }
      return sessionFromRow(row(value));
    } finally {
      statement.close();
    }
  }

  async list(): Promise<readonly StoredSession[]> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'SELECT * FROM sessions ORDER BY updated_at DESC, id DESC',
    );
    try {
      return statement.all().map((value) => sessionFromRow(row(value)));
    } finally {
      statement.close();
    }
  }

  async appendBatch(
    id: SessionId,
    expectedSequence: number,
    events: readonly ExecutionEvent[],
    finalStatus?: ExecutionStatus,
  ): Promise<StoredSession> {
    await Promise.resolve();
    try {
      this.#database.transaction(() => {
        const currentStatement = this.#database.connection.prepare(
          'SELECT last_sequence, status FROM sessions WHERE id = ?',
        );
        let current: Row;
        try {
          const value = currentStatement.get(id);
          if (value === undefined) {
            throw new PlinthwayError('SESSION_NOT_FOUND', `Session ${id} was not found`, {
              sessionId: id,
            });
          }
          current = row(value);
        } finally {
          currentStatement.close();
        }
        if (Number(current.last_sequence) !== expectedSequence) {
          throw new PlinthwayError('SESSION_CONFLICT', 'Session sequence changed concurrently', {
            sessionId: id,
            expectedSequence,
            actualSequence: Number(current.last_sequence),
          });
        }
        const insert = this.#database.connection.prepare(`
          INSERT INTO session_events(session_id, sequence, event_id, type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        try {
          events.forEach((event, index) => {
            insert.run(
              id,
              expectedSequence + index + 1,
              event.eventId,
              event.type,
              serializeForPersistence(event),
              event.createdAt,
            );
          });
        } finally {
          insert.close();
        }
        const update = this.#database.connection.prepare(
          'UPDATE sessions SET last_sequence = ?, status = ?, updated_at = ? WHERE id = ?',
        );
        try {
          update.run(
            expectedSequence + events.length,
            finalStatus ?? String(current.status),
            this.#now().toISOString(),
            id,
          );
        } finally {
          update.close();
        }
      });
    } catch (error) {
      if (error instanceof PlinthwayError) throw error;
      throw storageError(`Could not append events to session ${id}`, error);
    }
    return this.get(id);
  }

  async events(id: SessionId): Promise<readonly StoredSessionEvent[]> {
    await this.get(id);
    const statement = this.#database.connection.prepare(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence',
    );
    try {
      return statement.all(id).map((value) => eventFromRow(row(value)));
    } finally {
      statement.close();
    }
  }

  async history(id: SessionId): Promise<readonly StoredSessionEvent[]> {
    const session = await this.get(id);
    const own = await this.events(id);
    const branchFromSequence = session.branchFromSequence;
    if (session.parentSessionId === undefined || branchFromSequence === undefined) return own;
    const parent = (await this.history(session.parentSessionId)).filter(
      (entry) => entry.sequence <= branchFromSequence,
    );
    return deepFreeze([...parent, ...own]);
  }

  async reconstructMessages(id: SessionId): Promise<readonly LLMMessage[]> {
    return messagesFromEvents(await this.history(id));
  }

  async branch(
    parentId: SessionId,
    atSequence: number,
    input: BranchSessionInput,
  ): Promise<StoredSession> {
    const parent = await this.get(parentId);
    if (atSequence < 0 || atSequence > parent.lastSequence) {
      throw new PlinthwayError('SESSION_CONFLICT', 'Branch sequence is outside parent history', {
        sessionId: parentId,
        branchFromSequence: atSequence,
      });
    }
    return this.create({
      ...input,
      parentSessionId: parentId,
      branchFromSequence: atSequence,
    });
  }
}

function activeFromRow(value: Row | undefined): EffectiveProfile | undefined {
  if (value === undefined) return undefined;
  return parseSnapshot(String(value.snapshot_json), String(value.snapshot_hash));
}

export class SqliteActiveProfileStore {
  readonly #database: SessionDatabase;
  readonly #now: () => Date;

  constructor(database: SessionDatabase, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async get(): Promise<EffectiveProfile | undefined> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'SELECT snapshot_json, snapshot_hash FROM active_profile WHERE singleton = 1',
    );
    try {
      const value = statement.get();
      return activeFromRow(value === undefined ? undefined : row(value));
    } finally {
      statement.close();
    }
  }

  async set(profile: EffectiveProfile): Promise<void> {
    await Promise.resolve();
    const serialized = serializeForPersistence(profile);
    const statement = this.#database.connection.prepare(`
      INSERT INTO active_profile(singleton, profile_id, profile_generation_id, snapshot_json, snapshot_hash, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        profile_id = excluded.profile_id,
        profile_generation_id = excluded.profile_generation_id,
        snapshot_json = excluded.snapshot_json,
        snapshot_hash = excluded.snapshot_hash,
        updated_at = excluded.updated_at
    `);
    try {
      statement.run(
        profile.id,
        profile.generationId,
        serialized,
        sha256(serialized),
        this.#now().toISOString(),
      );
    } finally {
      statement.close();
    }
  }

  async clear(): Promise<void> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'DELETE FROM active_profile WHERE singleton = 1',
    );
    try {
      statement.run();
    } finally {
      statement.close();
    }
  }
}

export class SqliteSelectedProfileStore {
  readonly #database: SessionDatabase;
  readonly #now: () => Date;

  constructor(database: SessionDatabase, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async get(): Promise<string | undefined> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'SELECT profile_id FROM selected_profile WHERE singleton = 1',
    );
    try {
      const value = statement.get();
      return value === undefined ? undefined : String(row(value).profile_id);
    } finally {
      statement.close();
    }
  }

  async set(profileId: string): Promise<void> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(`
      INSERT INTO selected_profile(singleton, profile_id, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        profile_id = excluded.profile_id,
        updated_at = excluded.updated_at
    `);
    try {
      statement.run(profileId, this.#now().toISOString());
    } finally {
      statement.close();
    }
  }

  async clear(): Promise<void> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'DELETE FROM selected_profile WHERE singleton = 1',
    );
    try {
      statement.run();
    } finally {
      statement.close();
    }
  }
}

export type TransitionState = 'prepared' | 'committed' | 'rolled-back';

export interface ProfileTransition {
  readonly id: string;
  readonly previousProfileId?: string;
  readonly targetProfileId: string;
  readonly state: TransitionState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SqliteTransitionRepository {
  readonly #database: SessionDatabase;
  readonly #now: () => Date;

  constructor(database: SessionDatabase, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async begin(
    previous: EffectiveProfile | undefined,
    target: EffectiveProfile,
  ): Promise<ProfileTransition> {
    await Promise.resolve();
    const id = randomUUID();
    const now = this.#now().toISOString();
    serializeForPersistence({ id, previous: previous ?? null, target, createdAt: now });
    const statement = this.#database.connection.prepare(`
      INSERT INTO profile_transitions(
        id, previous_profile_id, target_profile_id, previous_snapshot_json,
        target_snapshot_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
    `);
    try {
      statement.run(
        id,
        previous?.id ?? null,
        target.id,
        previous === undefined ? null : serializeForPersistence(previous),
        serializeForPersistence(target),
        now,
        now,
      );
    } finally {
      statement.close();
    }
    return {
      id,
      ...(previous === undefined ? {} : { previousProfileId: previous.id }),
      targetProfileId: target.id,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
  }

  async commitWithActiveProfile(id: string, target: EffectiveProfile): Promise<void> {
    await Promise.resolve();
    this.#database.transaction(() => {
      const serialized = serializeForPersistence(target);
      const active = this.#database.connection.prepare(`
        INSERT INTO active_profile(singleton, profile_id, profile_generation_id, snapshot_json, snapshot_hash, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET profile_id=excluded.profile_id,
          profile_generation_id=excluded.profile_generation_id, snapshot_json=excluded.snapshot_json,
          snapshot_hash=excluded.snapshot_hash, updated_at=excluded.updated_at
      `);
      try {
        active.run(
          target.id,
          target.generationId,
          serialized,
          sha256(serialized),
          this.#now().toISOString(),
        );
      } finally {
        active.close();
      }
      const transition = this.#database.connection.prepare(
        "UPDATE profile_transitions SET state = 'committed', updated_at = ? WHERE id = ? AND state = 'prepared'",
      );
      try {
        const result = transition.run(this.#now().toISOString(), id);
        if (Number(result.changes) !== 1) throw storageError('Profile transition is not prepared');
      } finally {
        transition.close();
      }
    });
  }

  async rollback(id: string, error: unknown): Promise<void> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      "UPDATE profile_transitions SET state = 'rolled-back', error_json = ?, updated_at = ? WHERE id = ? AND state = 'prepared'",
    );
    try {
      statement.run(serializeForPersistence(redact(error)), this.#now().toISOString(), id);
    } finally {
      statement.close();
    }
  }

  async compensate(
    id: string,
    previous: EffectiveProfile | undefined,
    error: unknown,
  ): Promise<void> {
    await Promise.resolve();
    this.#database.transaction(() => {
      if (previous === undefined) {
        const clear = this.#database.connection.prepare(
          'DELETE FROM active_profile WHERE singleton = 1',
        );
        try {
          clear.run();
        } finally {
          clear.close();
        }
      } else {
        const serialized = serializeForPersistence(previous);
        const restore = this.#database.connection.prepare(`
          INSERT INTO active_profile(singleton, profile_id, profile_generation_id, snapshot_json, snapshot_hash, updated_at)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET profile_id=excluded.profile_id,
            profile_generation_id=excluded.profile_generation_id, snapshot_json=excluded.snapshot_json,
            snapshot_hash=excluded.snapshot_hash, updated_at=excluded.updated_at
        `);
        try {
          restore.run(
            previous.id,
            previous.generationId,
            serialized,
            sha256(serialized),
            this.#now().toISOString(),
          );
        } finally {
          restore.close();
        }
      }
      const transition = this.#database.connection.prepare(`
        UPDATE profile_transitions SET state = 'rolled-back', error_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('prepared', 'committed')
      `);
      try {
        const result = transition.run(
          serializeForPersistence(redact(error)),
          this.#now().toISOString(),
          id,
        );
        if (Number(result.changes) !== 1)
          throw storageError('Profile transition cannot be compensated');
      } finally {
        transition.close();
      }
    });
  }

  async list(): Promise<readonly ProfileTransition[]> {
    await Promise.resolve();
    const statement = this.#database.connection.prepare(
      'SELECT id, previous_profile_id, target_profile_id, state, created_at, updated_at FROM profile_transitions ORDER BY created_at, id',
    );
    try {
      return statement.all().map((value) => {
        const item = row(value);
        return {
          id: String(item.id),
          ...(optionalString(item.previous_profile_id) === undefined
            ? {}
            : { previousProfileId: String(item.previous_profile_id) }),
          targetProfileId: String(item.target_profile_id),
          state: String(item.state) as TransitionState,
          createdAt: String(item.created_at),
          updatedAt: String(item.updated_at),
        };
      });
    } finally {
      statement.close();
    }
  }
}
