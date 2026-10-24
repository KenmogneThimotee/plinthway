import { randomUUID } from 'node:crypto';

import { canonicalJson, PlinthwayError, type JsonValue, type McpRoot } from '@plinthway/shared';

export type McpInteractionMethod = 'roots/list' | 'sampling/createMessage' | 'elicitation/create';

export interface McpInteractionRequest {
  readonly id: string;
  readonly serverId: string;
  readonly method: McpInteractionMethod;
  readonly params: JsonValue;
  readonly deprecated: boolean;
}

export interface McpInteractionBrokerPort {
  readonly supportsSampling?: boolean;
  handle(
    serverId: string,
    method: McpInteractionMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
}

interface PendingInteraction {
  readonly request: McpInteractionRequest;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: PlinthwayError) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

export class McpInteractionBroker implements McpInteractionBrokerPort {
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #listeners = new Set<(request: McpInteractionRequest) => void>();
  readonly #rootConsents = new Set<string>();
  #roots: readonly McpRoot[] = [];

  setRoots(roots: readonly McpRoot[]): void {
    this.#roots = roots.map((root) => ({ ...root }));
    this.#rootConsents.clear();
  }

  onRequest(listener: (request: McpInteractionRequest) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pending(): readonly McpInteractionRequest[] {
    return [...this.#pending.values()].map(({ request }) => request);
  }

  async handle(
    serverId: string,
    method: McpInteractionMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (method === 'roots/list' && (this.#roots.length === 0 || this.#rootConsents.has(serverId))) {
      return toJson({ roots: this.#roots.map((root) => ({ ...root })) });
    }
    if (signal?.aborted === true) throw this.#cancelled(serverId, method);

    const request: McpInteractionRequest = {
      id: randomUUID(),
      serverId,
      method,
      params: toJson(params ?? {}),
      deprecated: method !== 'elicitation/create',
    };
    return new Promise<JsonValue>((resolve, reject) => {
      const onAbort = (): void => {
        this.cancel(request.id);
      };
      const pending: PendingInteraction = {
        request,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal, onAbort }),
      };
      this.#pending.set(request.id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const listener of this.#listeners) listener(request);
    });
  }

  approve(id: string, response?: unknown): void {
    const pending = this.#take(id);
    if (pending === undefined) return;
    if (pending.request.method === 'roots/list') {
      this.#rootConsents.add(pending.request.serverId);
      pending.resolve(toJson({ roots: this.#roots.map((root) => ({ ...root })) }));
      return;
    }
    if (response === undefined) {
      pending.reject(
        new PlinthwayError('CONFIG_INVALID', 'An interaction response is required', { id }),
      );
      return;
    }
    pending.resolve(toJson(response));
  }

  decline(id: string): void {
    const pending = this.#take(id);
    if (pending === undefined) return;
    if (pending.request.method === 'elicitation/create') {
      pending.resolve({ action: 'decline' });
    } else if (pending.request.method === 'roots/list') {
      pending.resolve({ roots: [] });
    } else {
      pending.reject(this.#cancelled(pending.request.serverId, pending.request.method));
    }
  }

  cancel(id: string): void {
    const pending = this.#take(id);
    if (pending === undefined) return;
    pending.reject(this.#cancelled(pending.request.serverId, pending.request.method));
  }

  #take(id: string): PendingInteraction | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }

  #cancelled(serverId: string, method: McpInteractionMethod): PlinthwayError {
    return new PlinthwayError('CANCELLED', `MCP ${method} interaction was cancelled`, {
      serverId,
      method,
    });
  }
}
