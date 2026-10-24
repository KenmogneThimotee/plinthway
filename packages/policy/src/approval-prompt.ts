import type {
  ApprovalResponse,
  PersistedApprovalDecision,
  ToolInvocationIdentity,
} from './approval.js';
import type { JsonValue } from '@plinthway/shared';

export interface ApprovalRequestDetails {
  readonly identity: ToolInvocationIdentity;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly targets: readonly string[];
  readonly readOnlyHint: boolean;
  readonly sideEffects: string;
}

export interface ApprovalPromptAttachment {
  readonly prompt: (request: ApprovalRequestDetails) => Promise<ApprovalResponse>;
  readonly persisted?: (decision: PersistedApprovalDecision) => void;
}

export class ApprovalPromptRouter {
  readonly #fallback: (request: ApprovalRequestDetails) => Promise<ApprovalResponse>;
  #attachment: ApprovalPromptAttachment | undefined;

  constructor(fallback: (request: ApprovalRequestDetails) => Promise<ApprovalResponse>) {
    this.#fallback = fallback;
  }

  attach(attachment: ApprovalPromptAttachment): () => void {
    this.#attachment = attachment;
    return () => {
      if (this.#attachment === attachment) this.#attachment = undefined;
    };
  }

  request(request: ApprovalRequestDetails): Promise<ApprovalResponse> {
    return (this.#attachment?.prompt ?? this.#fallback)(request);
  }

  decisionPersisted(decision: PersistedApprovalDecision): void {
    this.#attachment?.persisted?.(decision);
  }
}
