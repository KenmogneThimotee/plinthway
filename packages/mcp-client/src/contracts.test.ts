import { describe, expect, it } from 'vitest';

import type { McpServerStatus, McpTool, McpToolResult } from './contracts.js';

describe('MCP public contracts', () => {
  it('represents negotiated server identity, capabilities, auth, and recovery state', () => {
    const status = {
      serverId: 'docs',
      state: 'reconnecting',
      protocol: { era: 'modern', version: '2026-07-28' },
      serverInfo: {
        name: 'documentation',
        title: 'Documentation',
        version: '2.0.0',
        description: 'Product documentation',
        websiteUrl: 'https://example.com',
        icons: [{ src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml' }],
      },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
      },
      extensions: ['io.modelcontextprotocol/tasks'],
      authorization: { state: 'authorized', scopes: ['mcp:read'] },
      retryAt: '2026-10-18T10:00:00.000Z',
      lastError: { code: 'transport', message: 'connection reset', retryable: true },
      deprecationWarnings: ['Server negotiated deprecated logging support'],
    } satisfies McpServerStatus;

    expect(status.protocol.version).toBe('2026-07-28');
    expect(status.capabilities.resources.subscribe).toBe(true);
  });

  it('preserves complete tool and result metadata with server provenance', () => {
    const tool = {
      name: 'docs.search',
      nativeName: 'search',
      serverId: 'docs',
      title: 'Search docs',
      description: 'Search documentation',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
      annotations: {
        title: 'Search docs',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      icons: [
        {
          src: 'data:image/svg+xml;base64,PHN2Zy8+',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'light',
        },
      ],
      meta: { category: 'knowledge' },
    } satisfies McpTool;
    const result = {
      trusted: false,
      serverId: 'docs',
      toolName: 'docs.search',
      content: [{ type: 'text', text: 'one match', annotations: { audience: ['user'] } }],
      structuredContent: { hits: [{ title: 'MCP' }] },
      isError: false,
      meta: { traceId: 'trace-1' },
    } satisfies McpToolResult;

    expect(tool.outputSchema).toBeDefined();
    expect(result.structuredContent).toEqual({ hits: [{ title: 'MCP' }] });
  });
});
