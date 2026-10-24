import {
  deepFreeze,
  PlinthwayError,
  sha256,
  type ExecutionEvent,
  type ExecutionStatus,
  type LLMMessage,
  type SessionId,
} from '@plinthway/shared';

import {
  messagesFromEvents,
  serializeForPersistence,
  type BranchSessionInput,
  type CreateSessionInput,
  type SessionRepository,
  type StoredSession,
  type StoredSessionEvent,
} from './repository.js';

export interface MemorySessionRepositoryOptions {
  readonly now?: () => Date;
}

export class MemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<SessionId, StoredSession>();
  readonly #events = new Map<SessionId, StoredSessionEvent[]>();
  readonly #eventIds = new Set<string>();
  readonly #now: () => Date;

  constructor(options: MemorySessionRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateSessionInput): Promise<StoredSession> {
    await Promise.resolve();
    if (this.#sessions.has(input.id)) {
      throw new PlinthwayError('STORAGE_ERROR', `Session ${input.id} already exists`);
    }
    serializeForPersistence(input);
    serializeForPersistence(input.profile);
    if (input.parentSessionId !== undefined && !this.#sessions.has(input.parentSessionId)) {
      throw new PlinthwayError(
        'SESSION_NOT_FOUND',
        `Session ${input.parentSessionId} was not found`,
      );
    }
    const now = this.#now().toISOString();
    const stored = deepFreeze({
      id: input.id,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.branchFromSequence === undefined
        ? {}
        : { branchFromSequence: input.branchFromSequence }),
      profile: input.profile,
      profileHash: sha256(serializeForPersistence(input.profile)),
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      status: 'idle' as const,
      lastSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.#sessions.set(input.id, stored);
    this.#events.set(input.id, []);
    return stored;
  }

  async get(id: SessionId): Promise<StoredSession> {
    await Promise.resolve();
    const session = this.#sessions.get(id);
    if (session === undefined) {
      throw new PlinthwayError('SESSION_NOT_FOUND', `Session ${id} was not found`, {
        sessionId: id,
      });
    }
    return session;
  }

  async list(): Promise<readonly StoredSession[]> {
    await Promise.resolve();
    return [...this.#sessions.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    );
  }

  async appendBatch(
    id: SessionId,
    expectedSequence: number,
    events: readonly ExecutionEvent[],
    finalStatus?: ExecutionStatus,
  ): Promise<StoredSession> {
    const current = await this.get(id);
    if (current.lastSequence !== expectedSequence) {
      throw new PlinthwayError('SESSION_CONFLICT', 'Session sequence changed concurrently', {
        sessionId: id,
        expectedSequence,
        actualSequence: current.lastSequence,
      });
    }
    const pendingIds = new Set<string>();
    for (const event of events) {
      serializeForPersistence(event);
      if (this.#eventIds.has(event.eventId) || pendingIds.has(event.eventId)) {
        throw new PlinthwayError('STORAGE_ERROR', `Event ${event.eventId} already exists`);
      }
      pendingIds.add(event.eventId);
    }
    const storedEvents = events.map((event, index) =>
      deepFreeze({ sessionId: id, sequence: expectedSequence + index + 1, event }),
    );
    const next = deepFreeze({
      ...current,
      status: finalStatus ?? current.status,
      lastSequence: expectedSequence + events.length,
      updatedAt: this.#now().toISOString(),
    });
    this.#events.set(id, [...(this.#events.get(id) ?? []), ...storedEvents]);
    for (const eventId of pendingIds) this.#eventIds.add(eventId);
    this.#sessions.set(id, next);
    return next;
  }

  async events(id: SessionId): Promise<readonly StoredSessionEvent[]> {
    await this.get(id);
    return deepFreeze(this.#events.get(id) ?? []);
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
