import { describe, expect, it } from 'vitest';

import { discoverAppTools, isModelVisibleTool } from './catalog.js';

describe('MCP Apps tool discovery', () => {
  it('prefers modern UI metadata and supports the legacy resource key', () => {
    const tools = discoverAppTools('alpha', [
      {
        name: 'modern',
        inputSchema: { type: 'object' },
        meta: {
          ui: { resourceUri: 'ui://alpha/modern', visibility: ['app'] },
          'ui/resourceUri': 'ui://alpha/ignored',
        },
      },
      {
        name: 'legacy',
        inputSchema: { type: 'object' },
        meta: { 'ui/resourceUri': 'ui://alpha/legacy' },
      },
    ]);

    expect(tools).toEqual([
      expect.objectContaining({
        serverId: 'alpha',
        toolName: 'modern',
        resourceUri: 'ui://alpha/modern',
        visibility: ['app'],
      }),
      expect.objectContaining({
        serverId: 'alpha',
        toolName: 'legacy',
        resourceUri: 'ui://alpha/legacy',
        visibility: ['model', 'app'],
      }),
    ]);
  });

  it('rejects malformed UI URIs and hides app-only tools from the model', () => {
    expect(() =>
      discoverAppTools('alpha', [
        {
          name: 'bad',
          inputSchema: {},
          meta: { ui: { resourceUri: 'https://evil.example/app' } },
        },
      ]),
    ).toThrow(/ui:\/\//i);

    expect(isModelVisibleTool({ name: 'only-app', meta: { ui: { visibility: ['app'] } } })).toBe(
      false,
    );
    expect(
      isModelVisibleTool({ name: 'both', meta: { ui: { visibility: ['model', 'app'] } } }),
    ).toBe(true);
    expect(isModelVisibleTool({ name: 'default' })).toBe(true);
  });
});
