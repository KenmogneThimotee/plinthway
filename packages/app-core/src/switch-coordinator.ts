import { PlinthwayError, type EffectiveProfile } from '@plinthway/shared';
import type { QuiesceOptions } from '@plinthway/agent-core';

export type SwitchState = 'INACTIVE' | 'VALIDATING' | 'PREPARING' | 'ACTIVE';

export interface ProfileResolverPort {
  resolve(id: string): Promise<EffectiveProfile>;
}

export interface ActiveProfileMutationStore {
  get(): Promise<EffectiveProfile | undefined>;
  clear(): Promise<void>;
}

export interface PreparedProfileDependencies {
  readonly tools: readonly { readonly name: string }[];
  commit(): Promise<void>;
  rollback(): Promise<void>;
  releaseSuperseded(previous: EffectiveProfile | undefined): Promise<void>;
}

export interface ProfileDependencyPreparer {
  prepare(profile: EffectiveProfile): Promise<PreparedProfileDependencies>;
}

export interface TransitionPort {
  begin(
    previous: EffectiveProfile | undefined,
    target: EffectiveProfile,
  ): Promise<{ readonly id: string }>;
  commitWithActiveProfile(id: string, target: EffectiveProfile): Promise<void>;
  rollback(id: string, error: unknown): Promise<void>;
  compensate(id: string, previous: EffectiveProfile | undefined, error: unknown): Promise<void>;
  list(): Promise<readonly { readonly id: string; readonly state: string }[]>;
}

export interface ExecutionQuiescer {
  quiesce(options: QuiesceOptions): Promise<boolean>;
}

export interface ApprovalInvalidator {
  invalidateAll(): void;
}

export interface SwitchCoordinatorOptions {
  readonly profiles: ProfileResolverPort;
  readonly activeStore: ActiveProfileMutationStore;
  readonly dependencies: ProfileDependencyPreparer;
  readonly executionGate: ExecutionQuiescer;
  readonly transitions: TransitionPort;
  readonly approvals: ApprovalInvalidator;
}

function switchError(error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  return new PlinthwayError(
    'MCP_CONNECTION_FAILED',
    'Profile dependencies could not be activated',
    {},
    error instanceof Error ? { cause: error } : undefined,
  );
}

export class SwitchCoordinator {
  readonly #options: SwitchCoordinatorOptions;
  #state: SwitchState = 'INACTIVE';

  constructor(options: SwitchCoordinatorOptions) {
    this.#options = options;
  }

  get state(): SwitchState {
    return this.#state;
  }

  async initialize(): Promise<EffectiveProfile | undefined> {
    const active = await this.#options.activeStore.get();
    this.#state = active === undefined ? 'INACTIVE' : 'ACTIVE';
    for (const transition of await this.#options.transitions.list()) {
      if (transition.state === 'prepared') {
        await this.#options.transitions.rollback(
          transition.id,
          new PlinthwayError('CANCELLED', 'Prepared profile transition was interrupted'),
        );
      }
    }
    return active;
  }

  async switchProfile(id: string, busy: QuiesceOptions): Promise<EffectiveProfile> {
    const previous = await this.#options.activeStore.get();
    let prepared: PreparedProfileDependencies | undefined;
    let transition: { readonly id: string } | undefined;
    let activeCommitted = false;
    try {
      this.#state = 'VALIDATING';
      const target = await this.#options.profiles.resolve(id);
      this.#state = 'PREPARING';
      prepared = await this.#options.dependencies.prepare(target);
      if (!(await this.#options.executionGate.quiesce(busy))) {
        throw new PlinthwayError('CANCELLED', 'Profile switch cancellation was declined');
      }
      transition = await this.#options.transitions.begin(previous, target);
      await this.#options.transitions.commitWithActiveProfile(transition.id, target);
      activeCommitted = true;
      await prepared.commit();
      this.#options.approvals.invalidateAll();
      this.#state = 'ACTIVE';
      try {
        await prepared.releaseSuperseded(previous);
      } catch {
        // The target is already active and usable. Superseded cleanup is best-effort.
      }
      return target;
    } catch (error) {
      if (prepared !== undefined) await prepared.rollback().catch(() => undefined);
      if (transition !== undefined) {
        if (activeCommitted) {
          await this.#options.transitions.compensate(transition.id, previous, error);
        } else {
          await this.#options.transitions.rollback(transition.id, error);
        }
      }
      this.#state = previous === undefined ? 'INACTIVE' : 'ACTIVE';
      throw switchError(error);
    }
  }

  async deactivate(busy: QuiesceOptions): Promise<void> {
    if (!(await this.#options.executionGate.quiesce(busy))) {
      throw new PlinthwayError('CANCELLED', 'Profile deactivation cancellation was declined');
    }
    await this.#options.activeStore.clear();
    this.#options.approvals.invalidateAll();
    this.#state = 'INACTIVE';
  }
}
