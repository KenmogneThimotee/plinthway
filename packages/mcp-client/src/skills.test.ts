import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { PlinthwayError } from '@plinthway/shared';

import type { McpSkill, McpSkillConnectionPort, McpSkillResource } from './skills.js';
import { McpSkillHost } from './skills.js';

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

const instructions = `---\nname: refunds\ndescription: Process refunds safely\nallowed-tools: Bash\n---\n\n# Refunds\n\nFollow policy.\n`;
const guide = '# Guide\n';

function resource(uri: string, content: string): McpSkillResource {
  return { uri, digest: digest(content), size: Buffer.byteLength(content) };
}

function skill(
  uri = 'skill://acme/refunds/SKILL.md',
  resources: McpSkill['resources'] = [
    resource('skill://acme/refunds/SKILL.md', instructions),
    resource('skill://acme/refunds/references/GUIDE.md', guide),
  ],
): McpSkill {
  return {
    serverId: 'docs',
    uri,
    frontmatter: {
      name: 'refunds',
      description: 'Process refunds safely',
      'allowed-tools': 'Bash',
    },
    resources,
  };
}

function connection(entries: readonly McpSkill[] = [skill()]): McpSkillConnectionPort & {
  readonly readSkillResource: ReturnType<
    typeof vi.fn<
      (
        uri: string,
      ) => Promise<{ readonly uri: string; readonly bytes: Buffer; readonly mimeType?: string }>
    >
  >;
  readonly getSkill: ReturnType<typeof vi.fn<(uri: string) => Promise<McpSkill>>>;
} {
  const content = new Map([
    ['skill://acme/refunds/SKILL.md', instructions],
    ['skill://acme/refunds/references/GUIDE.md', guide],
    [
      'skill://acme/refunds/nested/SKILL.md',
      '---\nname: nested\ndescription: Nested instructions\n---\n\n# Nested\n',
    ],
  ]);
  return {
    serverId: 'docs',
    skillsEnabled: true,
    directoryReadEnabled: true,
    listSkills: () => Promise.resolve(entries),
    getSkill: vi.fn((uri: string) => {
      const found = entries.find((entry) => entry.uri === uri);
      return found === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(found);
    }),
    readSkillResource: vi.fn((uri: string) => {
      const text = content.get(uri);
      return text === undefined
        ? Promise.reject(new Error('missing'))
        : Promise.resolve({ uri, bytes: Buffer.from(text), mimeType: 'text/markdown' });
    }),
    readSkillDirectory: () => Promise.resolve([]),
  };
}

describe('McpSkillHost', () => {
  it('catalogs manifests without eagerly reading files and activates with origin-labelled context', async () => {
    const approve = vi.fn(() => Promise.resolve(true));
    const remote = connection();
    const host = new McpSkillHost({ approve });

    await host.replaceServer(remote);
    expect(host.list()).toEqual([skill()]);
    expect(remote.readSkillResource).not.toHaveBeenCalled();

    const active = await host.activate('docs', skill().uri, { requestedBy: 'user' });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'docs', uri: skill().uri, requestedBy: 'user' }),
    );
    expect(active.context).toContain('MCP SERVER ORIGIN: docs');
    expect(active.context).toContain('UNTRUSTED REMOTE SKILL');
    expect(active.context).toContain('allowed-tools does not grant permissions');
    expect(active.context).toContain('# Refunds');
    expect(remote.readSkillResource).toHaveBeenCalledTimes(1);
  });

  it('verifies each lazy read and serves immutable digest-keyed cache entries', async () => {
    const remote = connection();
    const host = new McpSkillHost({ approve: () => Promise.resolve(true) });
    await host.replaceServer(remote);
    await host.activate('docs', skill().uri, { requestedBy: 'model' });

    const first = await host.read('docs', skill().uri, 'references/GUIDE.md');
    const second = await host.read('docs', skill().uri, 'skill://acme/refunds/references/GUIDE.md');
    expect(first.bytes.toString('utf8')).toBe(guide);
    expect(second.bytes.toString('utf8')).toBe(guide);
    expect(remote.readSkillResource).toHaveBeenCalledTimes(2);
    expect(host.cacheSize).toBe(2);
    await expect(host.readDirectory('docs', skill().uri, 'references')).resolves.toEqual([
      {
        uri: 'skill://acme/refunds/references/GUIDE.md',
        name: 'GUIDE.md',
      },
    ]);
  });

  it.each([
    {
      name: 'size mismatch',
      entry: resource('skill://acme/refunds/SKILL.md', instructions),
      mutate: (entry: McpSkillResource) => ({ ...entry, size: entry.size + 1 }),
    },
    {
      name: 'digest mismatch',
      entry: resource('skill://acme/refunds/SKILL.md', instructions),
      mutate: (entry: McpSkillResource) => ({ ...entry, digest: `sha256:${'0'.repeat(64)}` }),
    },
  ])('rejects a $name', async ({ entry, mutate }) => {
    const remote = connection([skill(undefined, [mutate(entry)])]);
    const host = new McpSkillHost({ approve: () => Promise.resolve(true) });
    await host.replaceServer(remote);
    await expect(host.activate('docs', skill().uri, { requestedBy: 'user' })).rejects.toMatchObject(
      {
        code: 'MCP_PROTOCOL_ERROR',
      },
    );
  });

  it('rejects frontmatter mismatch, unlisted reads, traversal, and cross-server reads', async () => {
    const remote = connection();
    remote.readSkillResource.mockImplementation((uri: string) =>
      Promise.resolve({
        uri,
        bytes: Buffer.from(
          uri.endsWith('SKILL.md') ? instructions.replace('refunds safely', 'fraudulently') : guide,
        ),
      }),
    );
    const host = new McpSkillHost({ approve: () => Promise.resolve(true) });
    await host.replaceServer(remote);
    await expect(
      host.activate('docs', skill().uri, { requestedBy: 'user' }),
    ).rejects.toBeInstanceOf(PlinthwayError);

    const clean = connection();
    await host.replaceServer(clean);
    await host.activate('docs', skill().uri, { requestedBy: 'user' });
    await expect(host.read('docs', skill().uri, '../secrets.txt')).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
    });
    await expect(host.read('docs', skill().uri, '%2e%2e/secrets.txt')).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
    });
    await expect(
      host.read('docs', skill().uri, 'skill://acme/refunds/unlisted.txt'),
    ).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' });
    await expect(host.read('other', skill().uri, 'references/GUIDE.md')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
  });

  it('enforces the 512-file and 16-MiB manifest limits before approval', async () => {
    const tooMany = Array.from({ length: 513 }, (_, index) => ({
      uri:
        index === 0
          ? 'skill://acme/refunds/SKILL.md'
          : `skill://acme/refunds/assets/${String(index)}.txt`,
      digest: `sha256:${'0'.repeat(64)}`,
      size: 1,
    }));
    const tooLarge = [
      {
        uri: 'skill://acme/refunds/SKILL.md',
        digest: `sha256:${'0'.repeat(64)}`,
        size: 16 * 1024 * 1024 + 1,
      },
    ];
    for (const resources of [tooMany, tooLarge]) {
      const approve = vi.fn(() => Promise.resolve(true));
      const host = new McpSkillHost({ approve });
      await expect(
        host.replaceServer(connection([skill(undefined, resources)])),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(approve).not.toHaveBeenCalled();
    }
  });

  it('revokes content-bound approval when a refreshed manifest changes', async () => {
    const approve = vi.fn(() => Promise.resolve(true));
    const initial = skill();
    const updatedGuide = '# Updated guide\n';
    const updated = skill(undefined, [
      resource(initial.uri, instructions),
      resource('skill://acme/refunds/references/GUIDE.md', updatedGuide),
    ]);
    const remote = connection([initial]);
    remote.getSkill.mockResolvedValueOnce(initial).mockResolvedValueOnce(updated);
    const host = new McpSkillHost({ approve });
    await host.replaceServer(remote);

    await host.activate('docs', initial.uri, { requestedBy: 'user' });
    host.deactivate('docs', initial.uri);
    await host.activate('docs', initial.uri, { requestedBy: 'user' });

    expect(approve).toHaveBeenCalledTimes(2);
    expect(host.list()[0]?.resources).toEqual(updated.resources);
  });

  it('requires independent consent for nested skills and supports dynamic manifests', async () => {
    const nestedText = '---\nname: nested\ndescription: Nested instructions\n---\n\n# Nested\n';
    const parent = skill(undefined, [
      resource(skill().uri, instructions),
      resource('skill://acme/refunds/nested/SKILL.md', nestedText),
    ]);
    const nested: McpSkill = {
      serverId: 'docs',
      uri: 'skill://acme/refunds/nested/SKILL.md',
      frontmatter: { name: 'nested', description: 'Nested instructions' },
      resources: [resource('skill://acme/refunds/nested/SKILL.md', nestedText)],
    };
    const dynamic: McpSkill = {
      serverId: 'docs',
      uri: 'skill://reports/daily/SKILL.md',
      frontmatter: { name: 'daily', description: 'Daily report' },
      resources: 'dynamic',
    };
    const approve = vi.fn(() => Promise.resolve(true));
    const remote = connection([parent, nested, dynamic]);
    remote.readSkillResource.mockImplementation((uri: string) => {
      const value =
        uri === parent.uri
          ? instructions
          : uri === nested.uri
            ? nestedText
            : '---\nname: daily\ndescription: Daily report\n---\n';
      return Promise.resolve({ uri, bytes: Buffer.from(value) });
    });
    const host = new McpSkillHost({ approve });
    await host.replaceServer(remote);

    await host.activate('docs', parent.uri, { requestedBy: 'user' });
    await host.activate('docs', nested.uri, { requestedBy: 'user' });
    await host.activate('docs', dynamic.uri, { requestedBy: 'user' });
    expect(approve).toHaveBeenCalledTimes(3);
  });
});
