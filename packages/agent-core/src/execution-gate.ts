import { PlinthwayError, type ExecutionId } from '@plinthway/shared';

export interface ExecutionLease {
  readonly executionId: ExecutionId;
  readonly signal: AbortSignal;
  readonly release: () => void;
}

export interface QuiesceOptions {
  readonly onBusy: 'wait' | 'cancel';
  readonly confirmCancel?: () => Promise<boolean>;
}

interface ActiveExecution {
  readonly id: ExecutionId;
  readonly controller: AbortController;
  readonly idle: Promise<void>;
  readonly resolveIdle: () => void;
  released: boolean;
}

export class ExecutionGate {
  #active: ActiveExecution | undefined;

  get currentExecutionId(): ExecutionId | undefined {
    return this.#active?.id;
  }

  begin(executionId: ExecutionId, parentSignal?: AbortSignal): ExecutionLease {
    if (this.#active !== undefined) {
      throw new PlinthwayError('SESSION_CONFLICT', 'Another execution is already active');
    }
    const controller = new AbortController();
    let resolveIdle = (): void => undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const active: ActiveExecution = {
      id: executionId,
      controller,
      idle,
      resolveIdle,
      released: false,
    };
    this.#active = active;
    const onParentAbort = (): void => {
      controller.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted === true) onParentAbort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    return {
      executionId,
      signal: controller.signal,
      release: () => {
        if (active.released) return;
        active.released = true;
        parentSignal?.removeEventListener('abort', onParentAbort);
        if (this.#active === active) this.#active = undefined;
        active.resolveIdle();
      },
    };
  }

  cancel(reason: unknown = new PlinthwayError('CANCELLED', 'Execution was cancelled')): boolean {
    const active = this.#active;
    if (active === undefined || active.controller.signal.aborted) return false;
    active.controller.abort(reason);
    return true;
  }

  async waitForIdle(): Promise<void> {
    await this.#active?.idle;
  }

  async quiesce(options: QuiesceOptions): Promise<boolean> {
    const active = this.#active;
    if (active === undefined) return true;
    if (options.onBusy === 'cancel') {
      if (options.confirmCancel !== undefined && !(await options.confirmCancel())) return false;
      this.cancel();
    }
    await active.idle;
    return true;
  }
}
