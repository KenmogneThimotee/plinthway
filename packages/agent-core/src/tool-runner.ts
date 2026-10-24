import {
  PlinthwayError,
  type ExecutionId,
  type JsonValue,
  type SessionId,
  type ToolCall,
  type ToolInvocationDescription,
  type ToolInvocationResult,
} from '@plinthway/shared';
import {
  invocationIdentity,
  type ApprovalBroker,
  type ApprovalRequestDetails,
  type ApprovalResponse,
  type PolicyDecision,
  type PolicyEngine,
} from '@plinthway/policy';
export interface ToolInvoker {
  invoke(
    toolName: string,
    argumentsValue: unknown,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<ToolInvocationResult>;
  listTools?(): readonly {
    readonly name: string;
    readonly serverId?: string;
    readonly source?: { readonly kind: 'builtin' | 'mcp'; readonly id: string };
    readonly annotations?: { readonly readOnlyHint?: boolean };
  }[];
  describeInvocation?(
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ToolInvocationDescription>;
}

export interface ToolRunnerOptions {
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalBroker;
  readonly mcp: ToolInvoker;
  readonly sessionId: SessionId;
  readonly executionId: ExecutionId;
  readonly profileGenerationId: string;
  readonly timeoutMs: number;
}

export interface ToolRunOutcome {
  readonly decision: PolicyDecision;
  readonly approvalDecision?: ApprovalResponse;
  readonly result: ToolInvocationResult;
}

function errorContent(error: unknown): JsonValue {
  if (error instanceof PlinthwayError) return { code: error.code, message: error.message };
  return { code: 'MCP_PROTOCOL_ERROR', message: 'Tool invocation failed' };
}

function denied(call: ToolCall, code: string, message: string): ToolInvocationResult {
  return {
    trusted: false,
    toolName: call.toolName,
    content: { code, message },
    isError: true,
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(new PlinthwayError('CANCELLED', 'Execution was cancelled'));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new PlinthwayError('CANCELLED', 'Execution was cancelled'));
      },
      { once: true },
    );
  });
}

function invocationTargets(value: JsonValue): readonly string[] {
  const targets = new Set<string>();
  const visit = (candidate: JsonValue): void => {
    if (typeof candidate === 'string') {
      if (/^(?:https?:\/\/|file:\/\/|\.{0,2}[\\/]|[A-Za-z]:[\\/])/u.test(candidate)) {
        targets.add(candidate);
      }
    } else if (Array.isArray(candidate)) {
      for (const entry of candidate as readonly JsonValue[]) visit(entry);
    } else if (candidate !== null && typeof candidate === 'object') {
      for (const entry of Object.values(candidate)) visit(entry);
    }
  };
  visit(value);
  return [...targets].sort();
}

function approvalDetails(
  call: ToolCall,
  identity: ReturnType<typeof invocationIdentity>,
  mcp: ToolInvoker,
  description: ToolInvocationDescription,
): ApprovalRequestDetails {
  const tool = mcp.listTools?.().find((candidate) => candidate.name === call.toolName);
  const separator = call.toolName.indexOf('.');
  return {
    identity,
    serverId:
      tool?.source?.id ??
      tool?.serverId ??
      (separator === -1 ? '' : call.toolName.slice(0, separator)),
    toolName: call.toolName,
    arguments: call.input,
    targets: description.targets,
    readOnlyHint: description.readOnlyHint,
    sideEffects: description.sideEffects,
  };
}

async function describeInvocation(
  call: ToolCall,
  mcp: ToolInvoker,
): Promise<ToolInvocationDescription> {
  if (mcp.describeInvocation !== undefined) {
    return mcp.describeInvocation(call.toolName, call.input);
  }
  const tool = mcp.listTools?.().find((candidate) => candidate.name === call.toolName);
  const readOnlyHint = tool?.annotations?.readOnlyHint === true;
  return {
    targets: invocationTargets(call.input),
    readOnlyHint,
    sideEffects: readOnlyHint ? 'none anticipated' : 'may modify external state',
  };
}

export class ToolRunner {
  readonly #options: ToolRunnerOptions;

  constructor(options: ToolRunnerOptions) {
    this.#options = options;
  }

  async run(call: ToolCall, signal: AbortSignal): Promise<ToolRunOutcome> {
    let decision = this.#options.policy.decide({
      toolName: call.toolName,
      arguments: call.input,
    });
    if (decision.action === 'deny') {
      return {
        decision,
        result: denied(call, 'TOOL_DENIED', `Tool ${call.toolName} is denied by policy`),
      };
    }

    let description: ToolInvocationDescription;
    try {
      description = await describeInvocation(call, this.#options.mcp);
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'CANCELLED') throw error;
      return {
        decision,
        result: {
          ...denied(
            call,
            error instanceof PlinthwayError ? error.code : 'MCP_PROTOCOL_ERROR',
            error instanceof Error ? error.message : 'Tool invocation could not be described',
          ),
          content: errorContent(error),
        },
      };
    }
    if (description.riskFloor !== undefined) {
      decision = this.#options.policy.decide({
        toolName: call.toolName,
        arguments: call.input,
        riskFloor: description.riskFloor,
      });
    }

    if (decision.action === 'ask') {
      const identity = invocationIdentity({
        sessionId: this.#options.sessionId,
        executionId: this.#options.executionId,
        profileGenerationId: this.#options.profileGenerationId,
        callId: call.callId,
        toolName: call.toolName,
        arguments: call.input,
      });
      const outcome = await Promise.race([
        this.#options.approvals.request(
          identity,
          approvalDetails(call, identity, this.#options.mcp, description),
        ),
        abortPromise(signal),
      ]);
      if (outcome.decision === 'deny') {
        return {
          decision,
          approvalDecision: 'deny',
          result: denied(call, outcome.error.code, outcome.error.message),
        };
      }
      if (!this.#options.approvals.consume(outcome.grant, identity)) {
        throw new PlinthwayError(
          'APPROVAL_REQUIRED',
          `Approval no longer matches tool ${call.toolName}`,
        );
      }
      try {
        return {
          decision,
          approvalDecision: 'allow-once',
          result: await this.#options.mcp.invoke(call.toolName, call.input, {
            timeoutMs: this.#options.timeoutMs,
            signal,
          }),
        };
      } catch (error) {
        if (error instanceof PlinthwayError && error.code === 'CANCELLED') throw error;
        return {
          decision,
          approvalDecision: 'allow-once',
          result: denied(
            call,
            error instanceof PlinthwayError ? error.code : 'MCP_PROTOCOL_ERROR',
            error instanceof Error ? error.message : 'Tool invocation failed',
          ),
        };
      }
    }

    try {
      return {
        decision,
        result: await this.#options.mcp.invoke(call.toolName, call.input, {
          timeoutMs: this.#options.timeoutMs,
          signal,
        }),
      };
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'CANCELLED') throw error;
      return {
        decision,
        result: {
          ...denied(
            call,
            error instanceof PlinthwayError ? error.code : 'MCP_PROTOCOL_ERROR',
            error instanceof Error ? error.message : 'Tool invocation failed',
          ),
          content: errorContent(error),
        },
      };
    }
  }
}
