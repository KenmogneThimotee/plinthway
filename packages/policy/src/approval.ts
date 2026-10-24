import {
  canonicalJson,
  PlinthwayError,
  sha256,
  type ExecutionId,
  type SessionId,
} from '@plinthway/shared';
import type { ApprovalRequestDetails } from './approval-prompt.js';

export interface ToolInvocationIdentity {
  readonly sessionId: SessionId;
  readonly executionId: ExecutionId;
  readonly profileGenerationId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsHash: string;
}

export interface ToolInvocationInput extends Omit<ToolInvocationIdentity, 'argumentsHash'> {
  readonly arguments: unknown;
}

declare const grantBrand: unique symbol;

export interface ApprovalGrant {
  readonly [grantBrand]: true;
}

export type ApprovalResponse = 'allow-once' | 'deny';

export type ApprovalOutcome =
  | { readonly decision: 'allow-once'; readonly grant: ApprovalGrant }
  | { readonly decision: 'deny'; readonly error: PlinthwayError };

export interface PersistedApprovalDecision {
  readonly identity: ToolInvocationIdentity;
  readonly decision: ApprovalResponse;
}

export interface ApprovalBrokerOptions {
  readonly prompt: (
    identity: ToolInvocationIdentity,
    details?: ApprovalRequestDetails,
  ) => Promise<ApprovalResponse>;
  readonly persist: (decision: PersistedApprovalDecision) => Promise<void>;
}

export function invocationIdentity(input: ToolInvocationInput): ToolInvocationIdentity {
  let argumentsHash: string;
  try {
    argumentsHash = sha256(canonicalJson(input.arguments));
  } catch (error) {
    throw new PlinthwayError(
      'TOOL_ARGUMENTS_INVALID',
      'Tool arguments are not valid JSON',
      {},
      {
        cause: error,
      },
    );
  }
  return {
    sessionId: input.sessionId,
    executionId: input.executionId,
    profileGenerationId: input.profileGenerationId,
    callId: input.callId,
    toolName: input.toolName,
    argumentsHash,
  };
}

function identityKey(identity: ToolInvocationIdentity): string {
  return canonicalJson(identity);
}

export class ApprovalBroker {
  readonly #options: ApprovalBrokerOptions;
  #grantKeys = new WeakMap<ApprovalGrant, string>();
  #consumed = new WeakSet<ApprovalGrant>();
  readonly #pending = new Map<string, Promise<ApprovalOutcome>>();

  constructor(options: ApprovalBrokerOptions) {
    this.#options = options;
  }

  request(
    identity: ToolInvocationIdentity,
    details?: ApprovalRequestDetails,
  ): Promise<ApprovalOutcome> {
    const key = identityKey(identity);
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;

    const decision = this.#decide(identity, key, details);
    this.#pending.set(key, decision);
    const cleanup = (): void => {
      if (this.#pending.get(key) === decision) this.#pending.delete(key);
    };
    void decision.then(cleanup, cleanup);
    return decision;
  }

  async #decide(
    identity: ToolInvocationIdentity,
    key: string,
    details?: ApprovalRequestDetails,
  ): Promise<ApprovalOutcome> {
    const response = await this.#options.prompt(identity, details);
    await this.#options.persist({ identity, decision: response });
    if (response === 'deny') {
      return {
        decision: 'deny',
        error: new PlinthwayError('TOOL_DENIED', `Tool ${identity.toolName} was denied`, {
          toolName: identity.toolName,
          callId: identity.callId,
        }),
      };
    }
    const grant = Object.freeze({}) as ApprovalGrant;
    this.#grantKeys.set(grant, key);
    return { decision: 'allow-once', grant };
  }

  consume(grant: ApprovalGrant, identity: ToolInvocationIdentity): boolean {
    if (this.#consumed.has(grant) || this.#grantKeys.get(grant) !== identityKey(identity)) {
      return false;
    }
    this.#consumed.add(grant);
    return true;
  }

  invalidateAll(): void {
    this.#grantKeys = new WeakMap<ApprovalGrant, string>();
    this.#consumed = new WeakSet<ApprovalGrant>();
    this.#pending.clear();
  }
}
