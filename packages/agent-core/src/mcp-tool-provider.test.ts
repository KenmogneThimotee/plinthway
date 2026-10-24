import { describe, expect, it, vi } from 'vitest';

import type { McpManager } from '@plinthway/mcp-client';

import { McpToolProvider } from './mcp-tool-provider.js';

describe('McpToolProvider', () => {
  it('adapts active and prepared MCP tools to generic descriptors', async () => {
    const invoke = vi.fn().mockResolvedValue({
      trusted: false,
      serverId: 'docs',
      toolName: 'docs.search',
      content: { ok: true },
      isError: false,
    });
    const manager = {
      listTools: () => [
        {
          name: 'docs.search',
          nativeName: 'search',
          serverId: 'docs',
          description: 'Search documentation',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ],
      listPreparedTools: () => [
        {
          name: 'next.fetch',
          nativeName: 'fetch',
          serverId: 'next',
          inputSchema: { type: 'object' },
        },
      ],
      invoke,
      listActiveSkillContexts: () => ['remote skill'],
    } as unknown as McpManager;
    const provider = new McpToolProvider(manager);

    expect(provider.listTools()).toHaveLength(1);
    expect(provider.listTools()[0]).toMatchObject({
      name: 'docs.search',
      source: { kind: 'mcp', id: 'docs' },
      annotations: { readOnlyHint: true },
    });
    expect(provider.listPreparedTools()).toHaveLength(1);
    expect(provider.listPreparedTools()[0]).toMatchObject({
      name: 'next.fetch',
      source: { kind: 'mcp', id: 'next' },
    });
    expect(provider.listActiveSkillContexts()).toEqual(['remote skill']);
    await expect(
      provider.invoke('docs.search', { query: 'mcp' }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ toolName: 'docs.search', content: { ok: true } });
    expect(invoke).toHaveBeenCalledWith('docs.search', { query: 'mcp' }, { timeoutMs: 100 });
  });
});
