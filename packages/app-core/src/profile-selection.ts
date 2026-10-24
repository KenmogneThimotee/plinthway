import { PlinthwayError, type WorkProfile } from '@plinthway/shared';
import type { QuiesceOptions } from '@plinthway/agent-core';

export interface SelectedProfileStore {
  get(): Promise<string | undefined>;
  set(profileId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface StructuralProfileCatalog {
  get(id: string): Promise<WorkProfile>;
}

export class ProfileSelectionCoordinator {
  readonly #profiles: StructuralProfileCatalog;
  readonly #store: SelectedProfileStore;
  readonly #executionGate: { quiesce(options: QuiesceOptions): Promise<boolean> };
  readonly #approvals: { invalidateAll(): void };

  constructor(options: {
    profiles: StructuralProfileCatalog;
    store: SelectedProfileStore;
    executionGate: { quiesce(options: QuiesceOptions): Promise<boolean> };
    approvals: { invalidateAll(): void };
  }) {
    this.#profiles = options.profiles;
    this.#store = options.store;
    this.#executionGate = options.executionGate;
    this.#approvals = options.approvals;
  }

  async initialize(fallbackId = 'default'): Promise<WorkProfile | undefined> {
    const selected = await this.#store.get();
    if (selected !== undefined) {
      try {
        return await this.#profiles.get(selected);
      } catch (error) {
        if (!(error instanceof PlinthwayError) || error.code !== 'PROFILE_NOT_FOUND') throw error;
      }
    }
    try {
      const fallback = await this.#profiles.get(fallbackId);
      await this.#store.set(fallback.id);
      return fallback;
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'PROFILE_NOT_FOUND') return undefined;
      throw error;
    }
  }

  async select(id: string, busy: QuiesceOptions): Promise<WorkProfile> {
    const profile = await this.#profiles.get(id);
    if (!(await this.#executionGate.quiesce(busy))) {
      throw new PlinthwayError('CANCELLED', 'Profile selection cancellation was declined');
    }
    await this.#store.set(id);
    this.#approvals.invalidateAll();
    return profile;
  }

  async deactivate(busy: QuiesceOptions): Promise<void> {
    if (!(await this.#executionGate.quiesce(busy))) {
      throw new PlinthwayError('CANCELLED', 'Profile deactivation cancellation was declined');
    }
    await this.#store.clear();
    this.#approvals.invalidateAll();
  }
}
