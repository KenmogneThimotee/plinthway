import type { RegistrySyncResult } from '@plinthway/model-registry';

export type StartupState =
  | { readonly phase: 'syncing'; readonly attempt: number }
  | { readonly phase: 'blocked'; readonly attempt: number; readonly message: string }
  | { readonly phase: 'ready'; readonly attempt: number; readonly notice?: string };

export type StartupEvent =
  | { readonly type: 'retry' }
  | { readonly type: 'failed'; readonly message: string }
  | {
      readonly type: 'succeeded';
      readonly source: RegistrySyncResult['source'];
      readonly fallback: boolean;
    };

export function initialStartupState(): StartupState {
  return { phase: 'syncing', attempt: 0 };
}

export function startupReducer(state: StartupState, event: StartupEvent): StartupState {
  if (event.type === 'retry') return { phase: 'syncing', attempt: state.attempt + 1 };
  if (event.type === 'failed') {
    return { phase: 'blocked', attempt: state.attempt, message: event.message };
  }
  return {
    phase: 'ready',
    attempt: state.attempt,
    ...(event.fallback ? { notice: 'Network unavailable; using the cached model catalog.' } : {}),
  };
}
