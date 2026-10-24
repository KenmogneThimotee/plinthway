import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { asProfileId, type ToolDescriptor, type WorkProfile } from '@plinthway/shared';

import { effectiveToolPolicy, ToolsOverlay } from '../../src/tui/overlays/tools.js';

const profile: WorkProfile = {
  schemaVersion: 1,
  id: asProfileId('default'),
  name: 'Default',
  model: { fallback: [], parameters: {} },
  mcp: { enabled: ['docs'] },
  tools: { defaultPolicy: 'deny', rules: [{ tool: 'docs.*', action: 'allow' }] },
  agent: { maxSteps: 5 },
  session: { persist: true },
};

const tools: readonly ToolDescriptor[] = [
  {
    name: 'filesystem.read_text',
    source: { kind: 'builtin', id: 'filesystem' },
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    intrinsicAction: 'allow',
  },
  {
    name: 'shell.run',
    source: { kind: 'builtin', id: 'shell' },
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false },
    intrinsicAction: 'ask',
  },
  {
    name: 'docs.search',
    source: { kind: 'mcp', id: 'docs' },
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
];

describe('ToolsOverlay', () => {
  it('renders grouped source labels and effective policy decisions', () => {
    expect(effectiveToolPolicy(profile, tools, 'filesystem.read_text')).toBe('allow');
    expect(effectiveToolPolicy(profile, tools, 'shell.run')).toBe('ask');
    expect(effectiveToolPolicy(profile, tools, 'docs.search')).toBe('allow');

    const output = renderToString(
      <ToolsOverlay
        tools={tools}
        policyFor={(name) => effectiveToolPolicy(profile, tools, name)}
      />,
    );
    expect(output).toContain('built-in filesystem');
    expect(output).toContain('built-in shell');
    expect(output).toContain('MCP docs');
    expect(output).toContain('filesystem.read_text · built-in filesystem · policy allow');
  });
});
