import { describe, expect, it, vi } from 'vitest';

import { McpSkillsProtocol, decodeSkillResourceResult } from './skills-protocol.js';

const manifest = {
  uri: 'skill://docs/review/SKILL.md',
  frontmatter: { name: 'review', description: 'Review changes' },
  resources: [
    {
      uri: 'skill://docs/review/SKILL.md',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 10,
    },
  ],
} as const;

describe('McpSkillsProtocol', () => {
  it('aggregates paginated skills and honors cache freshness hints', async () => {
    const request = vi.fn((message: { method: string; params?: Record<string, unknown> }) => {
      if (message.params?.cursor === undefined) {
        return Promise.resolve({
          resultType: 'complete',
          skills: [manifest],
          nextCursor: 'page-2',
          ttlMs: 60_000,
          cacheScope: 'public',
        });
      }
      return Promise.resolve({
        resultType: 'complete',
        skills: [
          {
            ...manifest,
            uri: 'skill://docs/lint/SKILL.md',
            frontmatter: { name: 'lint', description: 'Lint changes' },
            resources: 'dynamic',
          },
        ],
        ttlMs: 30_000,
        cacheScope: 'private',
      });
    });
    const protocol = new McpSkillsProtocol('docs', request);

    const first = await protocol.list();
    const second = await protocol.list();
    expect(first.map((skill) => skill.uri)).toEqual([
      'skill://docs/review/SKILL.md',
      'skill://docs/lint/SKILL.md',
    ]);
    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ params: { cursor: 'page-2' } });
    expect(protocol.listCacheHint).toEqual({ ttlMs: 30_000, cacheScope: 'private' });
  });

  it('supports direct lookup and refreshes dynamic manifests', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        resultType: 'complete',
        skill: { ...manifest, resources: 'dynamic' },
        ttlMs: 60_000,
        cacheScope: 'public',
      })
      .mockResolvedValueOnce({
        resultType: 'complete',
        skill: manifest,
        ttlMs: 60_000,
        cacheScope: 'public',
      });
    const protocol = new McpSkillsProtocol('docs', request);

    expect((await protocol.get(manifest.uri)).resources).toBe('dynamic');
    expect((await protocol.get(manifest.uri)).resources).toBe('dynamic');
    expect((await protocol.get(manifest.uri, { refresh: true })).resources).toEqual(
      manifest.resources,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: 'skills/get',
      params: { uri: manifest.uri },
    });
  });

  it('reads optional directories with pagination only when negotiated', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        resultType: 'complete',
        resources: [{ uri: 'skill://docs/review/a.md', name: 'a.md' }],
        nextCursor: 'more',
        ttlMs: 10,
        cacheScope: 'public',
      })
      .mockResolvedValueOnce({
        resultType: 'complete',
        resources: [
          { uri: 'skill://docs/review/nested', name: 'nested', mimeType: 'inode/directory' },
        ],
        ttlMs: 10,
        cacheScope: 'public',
      });
    const protocol = new McpSkillsProtocol('docs', request, { directoryRead: true });
    await expect(protocol.readDirectory('skill://docs/review')).resolves.toHaveLength(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ params: { cursor: 'more' } });

    const disabled = new McpSkillsProtocol('docs', request);
    await expect(disabled.readDirectory('skill://docs/review')).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
  });

  it('rejects malformed results and pagination loops', async () => {
    const malformed = new McpSkillsProtocol('docs', () =>
      Promise.resolve({ resultType: 'complete', skills: [manifest], ttlMs: 10 }),
    );
    await expect(malformed.list()).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });

    const looping = new McpSkillsProtocol('docs', () =>
      Promise.resolve({
        resultType: 'complete',
        skills: [],
        nextCursor: 'same',
        ttlMs: 10,
        cacheScope: 'public',
      }),
    );
    await expect(looping.list()).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
  });
});

describe('decodeSkillResourceResult', () => {
  it('preserves exact UTF-8 and base64 bytes', () => {
    expect(
      decodeSkillResourceResult('skill://docs/review/SKILL.md', {
        contents: [
          { uri: 'skill://docs/review/SKILL.md', mimeType: 'text/markdown', text: 'héllo\n' },
        ],
      }).bytes,
    ).toEqual(Buffer.from('héllo\n'));
    expect(
      decodeSkillResourceResult('skill://docs/review/image.bin', {
        contents: [
          { uri: 'skill://docs/review/image.bin', blob: Buffer.from([0, 255]).toString('base64') },
        ],
      }).bytes,
    ).toEqual(Buffer.from([0, 255]));
  });

  it('rejects ambiguous, mismatched, and invalid resource content', () => {
    expect(() =>
      decodeSkillResourceResult('skill://docs/review/SKILL.md', {
        contents: [{ uri: 'skill://other/SKILL.md', text: 'wrong' }],
      }),
    ).toThrow();
    expect(() =>
      decodeSkillResourceResult('skill://docs/review/SKILL.md', {
        contents: [{ uri: 'skill://docs/review/SKILL.md', text: 'x', blob: 'eA==' }],
      }),
    ).toThrow();
    expect(() =>
      decodeSkillResourceResult('skill://docs/review/SKILL.md', {
        contents: [{ uri: 'skill://docs/review/SKILL.md', blob: '***' }],
      }),
    ).toThrow();
  });
});
