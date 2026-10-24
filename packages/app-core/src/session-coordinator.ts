import {
  PlinthwayError,
  newEventId,
  newSessionId,
  type EffectiveProfile,
  type LLMEvent,
  type SessionId,
} from '@plinthway/shared';
import type { AgentRunInput } from '@plinthway/agent-core';
import type { SessionRepository, StoredSession } from '@plinthway/sessions';
import type { PersistedApprovalDecision } from '@plinthway/policy';

import type { ProfileResolverPort } from './switch-coordinator.js';

export interface SessionActiveProfileStore {
  get(): Promise<EffectiveProfile | undefined>;
}

export interface SessionSelectedProfileStore {
  get(): Promise<string | undefined>;
}

export interface SessionEngine {
  run(input: AgentRunInput): AsyncGenerator<LLMEvent, void, void>;
}

export interface SessionCoordinatorOptions {
  readonly durable: SessionRepository;
  readonly memory: SessionRepository;
  readonly activeStore: SessionActiveProfileStore;
  readonly selectedStore?: SessionSelectedProfileStore;
  readonly profiles: ProfileResolverPort;
  readonly currentMcpEnabled?: (profileId: string) => Promise<readonly string[]>;
  readonly engineFor: (repository: SessionRepository) => SessionEngine;
  readonly prepareSnapshot?: (profile: EffectiveProfile) => Promise<void>;
  readonly newSessionId?: () => SessionId;
}

export interface NewSessionOptions {
  readonly profileId?: string;
  readonly modelOverride?: string;
}

export interface ResumeReady {
  readonly status: 'ready';
  readonly session: StoredSession;
}

export interface ResumeRecoveryRequired {
  readonly status: 'recovery-required';
  readonly session: StoredSession;
  readonly choices: readonly ['retry', 'read-only', 'branch'];
  readonly error: PlinthwayError;
}

export type ResumeResult = ResumeReady | ResumeRecoveryRequired;

function validateOverride(profile: EffectiveProfile, override: string | undefined): void {
  if (override === undefined) return;
  if (override !== profile.model.primary && !profile.model.fallback.includes(override)) {
    throw new PlinthwayError(
      'MODEL_NOT_FOUND',
      `Model ${override} is not allowed by this profile`,
      {
        modelId: override,
        profileId: profile.id,
      },
    );
  }
}

function recoveryError(error: unknown): PlinthwayError {
  return error instanceof PlinthwayError
    ? error
    : new PlinthwayError(
        'MCP_CONNECTION_FAILED',
        'Saved session dependencies are unavailable',
        {},
        error instanceof Error ? { cause: error } : undefined,
      );
}

export class SessionCoordinator {
  readonly #options: SessionCoordinatorOptions;
  readonly #sessionStores = new Map<SessionId, SessionRepository>();

  constructor(options: SessionCoordinatorOptions) {
    this.#options = options;
  }

  async #profile(profileId?: string): Promise<EffectiveProfile> {
    if (profileId !== undefined) return this.#options.profiles.resolve(profileId);
    const selected = await this.#options.selectedStore?.get();
    if (selected !== undefined) return this.#options.profiles.resolve(selected);
    const active = await this.#options.activeStore.get();
    if (active === undefined) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', 'No active profile is selected');
    }
    return active;
  }

  #repository(profile: EffectiveProfile): SessionRepository {
    return profile.session.persist ? this.#options.durable : this.#options.memory;
  }

  async #locate(id: SessionId): Promise<{ session: StoredSession; repository: SessionRepository }> {
    const known = this.#sessionStores.get(id);
    if (known !== undefined) return { session: await known.get(id), repository: known };
    try {
      const session = await this.#options.durable.get(id);
      this.#sessionStores.set(id, this.#options.durable);
      return { session, repository: this.#options.durable };
    } catch (error) {
      if (!(error instanceof PlinthwayError) || error.code !== 'SESSION_NOT_FOUND') throw error;
    }
    const session = await this.#options.memory.get(id);
    this.#sessionStores.set(id, this.#options.memory);
    return { session, repository: this.#options.memory };
  }

  async newSession(options: NewSessionOptions = {}): Promise<StoredSession> {
    const profile = await this.#profile(options.profileId);
    validateOverride(profile, options.modelOverride);
    await this.#options.prepareSnapshot?.(profile);
    const repository = this.#repository(profile);
    const id = this.#options.newSessionId?.() ?? newSessionId();
    const session = await repository.create({
      id,
      profile,
      ...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
    });
    this.#sessionStores.set(id, repository);
    return session;
  }

  async run(
    prompt: string,
    options: NewSessionOptions & {
      readonly sessionId?: SessionId;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<{ readonly session: StoredSession; readonly events: AsyncGenerator<LLMEvent> }> {
    const located =
      options.sessionId === undefined ? undefined : await this.#locate(options.sessionId);
    const session = located?.session ?? (await this.newSession(options));
    const repository = located?.repository ?? this.#sessionStores.get(session.id);
    if (repository === undefined)
      throw new PlinthwayError('STORAGE_ERROR', 'Session store was lost');
    return {
      session,
      events: this.#options.engineFor(repository).run({
        sessionId: session.id,
        prompt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    };
  }

  async resume(id: SessionId): Promise<ResumeResult> {
    const { session } = await this.#locate(id);
    try {
      const savedEnabled = [...session.profile.mcp.enabled].sort((left, right) =>
        left.localeCompare(right),
      );
      const currentEnabled = [
        ...(this.#options.currentMcpEnabled === undefined
          ? (await this.#options.profiles.resolve(session.profile.id)).mcp.enabled
          : await this.#options.currentMcpEnabled(session.profile.id)),
      ].sort((left, right) => left.localeCompare(right));
      if (savedEnabled.join('\u0000') !== currentEnabled.join('\u0000')) {
        throw new PlinthwayError(
          'MCP_CONNECTION_FAILED',
          'Saved session MCP connections differ from the current profile; branch the session to use the current selection',
          {
            profileId: session.profile.id,
            savedEnabled,
            currentEnabled,
          },
        );
      }
      await this.#options.prepareSnapshot?.(session.profile);
      return { status: 'ready', session };
    } catch (error) {
      return {
        status: 'recovery-required',
        session,
        choices: ['retry', 'read-only', 'branch'],
        error: recoveryError(error),
      };
    }
  }

  async branch(
    parentId: SessionId,
    options: NewSessionOptions & {
      readonly atSequence?: number;
      readonly skipDependencyPreparation?: boolean;
    },
  ): Promise<StoredSession> {
    if (options.profileId === undefined) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', 'A target profile is required for branching');
    }
    const { session: parent, repository } = await this.#locate(parentId);
    const profile = await this.#profile(options.profileId);
    validateOverride(profile, options.modelOverride);
    if (options.skipDependencyPreparation !== true) {
      await this.#options.prepareSnapshot?.(profile);
    }
    const id = this.#options.newSessionId?.() ?? newSessionId();
    const child = await repository.branch(parentId, options.atSequence ?? parent.lastSequence, {
      id,
      profile,
      ...(options.modelOverride === undefined ? {} : { modelOverride: options.modelOverride }),
    });
    this.#sessionStores.set(id, repository);
    return child;
  }

  async persistApproval(decision: PersistedApprovalDecision): Promise<void> {
    const { session, repository } = await this.#locate(decision.identity.sessionId);
    await repository.appendBatch(decision.identity.sessionId, session.lastSequence, [
      {
        eventId: newEventId(),
        createdAt: new Date().toISOString(),
        type: 'approval-decided',
        callId: decision.identity.callId,
        decision: decision.decision,
      },
    ]);
  }

  async listDurable(): Promise<readonly StoredSession[]> {
    return this.#options.durable.list();
  }
}
