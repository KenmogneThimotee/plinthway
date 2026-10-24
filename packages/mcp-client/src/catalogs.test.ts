import { describe, expect, it } from 'vitest';

import type { McpConnectionPort } from './contracts.js';
import { CapabilityCatalogs } from './catalogs.js';

function connection(serverId: string): McpConnectionPort {
  return {
    serverId,
    state: 'ready',
    listTools: () => Promise.resolve([]),
    callTool: () => Promise.resolve({ content: [] }),
    close: () => Promise.resolve(),
  };
}

describe('CapabilityCatalogs', () => {
  it('namespaces prompts and keeps resource identity bound to server plus URI', () => {
    const catalogs = new CapabilityCatalogs();
    const docs = connection('docs');
    const code = connection('code');
    catalogs.add(docs, {
      prompts: [
        {
          name: 'review',
          title: 'Review docs',
          arguments: [{ name: 'topic', required: true }],
        },
      ],
      resources: [{ uri: 'file:///shared', name: 'Shared' }],
      resourceTemplates: [{ uriTemplate: 'docs://{slug}', name: 'Doc', mimeType: 'text/markdown' }],
    });
    catalogs.add(code, {
      prompts: [{ name: 'review', title: 'Review code' }],
      resources: [{ uri: 'file:///shared', name: 'Shared' }],
      resourceTemplates: [],
    });

    expect(catalogs.listPrompts().map(({ name }) => name)).toEqual(['code.review', 'docs.review']);
    expect(catalogs.getPrompt('docs.review')?.prompt.title).toBe('Review docs');
    expect(catalogs.listResources()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'docs', uri: 'file:///shared' }),
        expect.objectContaining({ serverId: 'code', uri: 'file:///shared' }),
      ]),
    );
    expect(catalogs.getResource('docs', 'file:///shared')?.connection).toBe(docs);
    expect(catalogs.listResourceTemplates()[0]).toMatchObject({
      serverId: 'docs',
      uriTemplate: 'docs://{slug}',
    });
  });

  it('removes every catalog entry owned by a disconnected connection', () => {
    const catalogs = new CapabilityCatalogs();
    const docs = connection('docs');
    catalogs.add(docs, {
      prompts: [{ name: 'review' }],
      resources: [{ uri: 'docs://guide', name: 'Guide' }],
      resourceTemplates: [{ uriTemplate: 'docs://{slug}', name: 'Doc' }],
    });
    catalogs.remove(docs);
    expect(catalogs.listPrompts()).toEqual([]);
    expect(catalogs.listResources()).toEqual([]);
    expect(catalogs.listResourceTemplates()).toEqual([]);
  });
});
