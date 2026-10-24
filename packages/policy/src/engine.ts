import { canonicalJson, type ToolAction, type ToolRule, type ToolSource } from '@plinthway/shared';

import { matchToolRule } from './matcher.js';

export interface DiscoveredToolMetadata {
  readonly name: string;
  readonly serverId?: string;
  readonly source?: ToolSource;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly intrinsicAction?: ToolAction;
}

export type PolicyDecisionReason =
  | 'rule-exact'
  | 'rule-wildcard'
  | 'profile-default'
  | 'intrinsic-default'
  | 'side-effect-clamp'
  | 'risk-floor'
  | 'server-disabled'
  | 'tool-unknown'
  | 'arguments-invalid';

export interface PolicyDecision {
  readonly action: ToolAction;
  readonly reason: PolicyDecisionReason;
  readonly matchedRule?: ToolRule;
}

export interface ToolPolicyInvocation {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly riskFloor?: 'allow' | 'ask';
}

export interface PolicyEngineOptions {
  readonly enabledServers: readonly string[];
  readonly defaultPolicy: ToolAction;
  readonly rules: readonly ToolRule[];
  readonly tools: readonly DiscoveredToolMetadata[];
}

export class PolicyEngine {
  readonly #enabledServers: ReadonlySet<string>;
  readonly #defaultPolicy: ToolAction;
  readonly #rules: readonly ToolRule[];
  readonly #tools: ReadonlyMap<string, DiscoveredToolMetadata>;

  constructor(options: PolicyEngineOptions) {
    this.#enabledServers = new Set(options.enabledServers);
    this.#defaultPolicy = options.defaultPolicy;
    this.#rules = [...options.rules];
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  decide(invocation: ToolPolicyInvocation): PolicyDecision {
    const tool = this.#tools.get(invocation.toolName);
    if (tool === undefined) return { action: 'deny', reason: 'tool-unknown' };
    const requiredServer = tool.source?.kind === 'mcp' ? tool.source.id : tool.serverId;
    if (tool.source?.kind !== 'builtin' && !this.#enabledServers.has(requiredServer ?? '')) {
      return { action: 'deny', reason: 'server-disabled' };
    }
    try {
      canonicalJson(invocation.arguments);
    } catch {
      return { action: 'deny', reason: 'arguments-invalid' };
    }

    const matched = matchToolRule(invocation.toolName, this.#rules);
    const action = matched?.action ?? tool.intrinsicAction ?? this.#defaultPolicy;
    if (action === 'deny') {
      return {
        action,
        reason:
          matched?.exact === true
            ? 'rule-exact'
            : matched === undefined
              ? tool.intrinsicAction === undefined
                ? 'profile-default'
                : 'intrinsic-default'
              : 'rule-wildcard',
        ...(matched === undefined ? {} : { matchedRule: matched }),
      };
    }

    const exactAllow = matched?.exact === true && matched.action === 'allow';
    if (action === 'allow' && invocation.riskFloor === 'ask' && !exactAllow) {
      return {
        action: 'ask',
        reason: 'risk-floor',
        ...(matched === undefined ? {} : { matchedRule: matched }),
      };
    }
    if (action === 'allow' && tool.annotations?.readOnlyHint !== true && !exactAllow) {
      return {
        action: 'ask',
        reason: 'side-effect-clamp',
        ...(matched === undefined ? {} : { matchedRule: matched }),
      };
    }

    return {
      action,
      reason:
        matched?.exact === true
          ? 'rule-exact'
          : matched === undefined
            ? tool.intrinsicAction === undefined
              ? 'profile-default'
              : 'intrinsic-default'
            : 'rule-wildcard',
      ...(matched === undefined ? {} : { matchedRule: matched }),
    };
  }
}
