import { Fragment } from 'react';
import { Text } from 'ink';
import { PolicyEngine } from '@plinthway/policy';
import type { ToolDescriptor, WorkProfile } from '@plinthway/shared';

import { OverlayFrame } from './frame.js';

function sourceLabel(tool: ToolDescriptor): string {
  return tool.source.kind === 'builtin' ? `built-in ${tool.source.id}` : `MCP ${tool.source.id}`;
}

export function effectiveToolPolicy(
  profile: WorkProfile,
  tools: readonly ToolDescriptor[],
  name: string,
): string {
  return new PolicyEngine({
    enabledServers: profile.mcp?.enabled ?? [],
    defaultPolicy: profile.tools.defaultPolicy,
    rules: profile.tools.rules,
    tools,
  }).decide({ toolName: name, arguments: {} }).action;
}

export function ToolsOverlay({
  tools,
  policyFor,
}: {
  readonly tools: readonly ToolDescriptor[];
  readonly policyFor: (name: string) => string;
}) {
  return (
    <OverlayFrame title="Effective tools (read-only)">
      {tools.length === 0 ? (
        <Text>No tools are available.</Text>
      ) : (
        [...Map.groupBy(tools, (tool) => sourceLabel(tool)).entries()].map(([source, group]) => (
          <Fragment key={source}>
            <Text bold>{source}</Text>
            {group.map((tool) => (
              <Text key={tool.name}>
                {tool.name} · {source} · policy {policyFor(tool.name)} ·{' '}
                {tool.annotations?.readOnlyHint === true ? 'read-only' : 'may have side effects'} ·
                schema {JSON.stringify(tool.inputSchema)}
              </Text>
            ))}
          </Fragment>
        ))
      )}
    </OverlayFrame>
  );
}
