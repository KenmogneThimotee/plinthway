import type { ToolAction, ToolRule } from '@plinthway/shared';

const TOOL_PATTERN = /^[A-Za-z0-9_-]+\.(?:\*|[A-Za-z0-9_.-]+)$/u;

export interface MatchedToolRule extends ToolRule {
  readonly exact: boolean;
  readonly index: number;
}

export function validateToolPattern(pattern: string): void {
  if (!TOOL_PATTERN.test(pattern) || pattern.slice(0, -1).includes('*')) {
    throw new TypeError(
      'Tool rules must be exact server.tool names or terminal server.* wildcards',
    );
  }
}

function matches(toolName: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) return toolName.startsWith(pattern.slice(0, -1));
  return toolName === pattern;
}

function actionPriority(action: ToolAction): number {
  return action === 'deny' ? 0 : action === 'ask' ? 1 : 2;
}

export function matchToolRule(
  toolName: string,
  rules: readonly ToolRule[],
): MatchedToolRule | undefined {
  const candidates: MatchedToolRule[] = [];
  rules.forEach((rule, index) => {
    validateToolPattern(rule.tool);
    if (matches(toolName, rule.tool)) {
      candidates.push({ ...rule, exact: !rule.tool.endsWith('.*'), index });
    }
  });
  candidates.sort((left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1;
    const action = actionPriority(left.action) - actionPriority(right.action);
    return action === 0 ? left.index - right.index : action;
  });
  return candidates[0];
}
