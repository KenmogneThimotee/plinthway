import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function text(file: string): Promise<string> {
  return readFile(path.resolve(file), 'utf8');
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(file)) as Record<string, unknown>;
}

describe('open-source repository surface', () => {
  it('publishes the unscoped Plinthway package with complete repository metadata', async () => {
    const root = await json('package.json');
    const cli = await json('apps/cli/package.json');

    expect(root.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/KenmogneThimotee/plinthway.git',
    });
    expect(root.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(cli).toMatchObject({
      name: 'plinthway',
      author: 'KenmogneThimotee',
      homepage: 'https://github.com/KenmogneThimotee/plinthway#readme',
      bugs: { url: 'https://github.com/KenmogneThimotee/plinthway/issues' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/KenmogneThimotee/plinthway.git',
        directory: 'apps/cli',
      },
      publishConfig: { access: 'public' },
    });
    expect(cli.keywords).toEqual(
      expect.arrayContaining(['ai', 'cli', 'mcp', 'model-context-protocol', 'agents']),
    );
    expect(cli.dependencies).toMatchObject({ yaml: '2.9.1' });
  });

  it('ships the expected community and release files without internal planning documents', async () => {
    const required = [
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'SUPPORT.md',
      '.github/dependabot.yml',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/pull_request_template.md',
      '.github/workflows/ci.yml',
      '.github/workflows/publish.yml',
    ];
    await expect(
      Promise.all(required.map((file) => access(path.resolve(file)))),
    ).resolves.toHaveLength(required.length);
    await expect(access(path.resolve('docs/superpowers'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('documents the installable command and config migration without the retired executable', async () => {
    const readme = await text('README.md');
    expect(readme).toContain('npm install --global plinthway');
    expect(readme).toContain('plinthway chat');
    expect(readme).toContain('HARNESS_HOME');
    expect(readme).not.toContain('@plinthway/cli');
    expect(readme).not.toMatch(/\bharness (?:chat|run|auth|mcp|profile|models|init)\b/u);
  });

  it('uses Plinthway artifact names and an OIDC-only future publish workflow', async () => {
    const ci = await text('.github/workflows/ci.yml');
    expect(ci).toContain('pnpm --filter plinthway pack');
    expect(ci).toContain('plinthway-cli-');
    expect(ci).toContain("bun --filter '*' build");
    expect(ci).not.toContain('bun run build');
    expect(ci).not.toContain('@plinthway/cli');
    expect(ci).not.toContain('harness-release-artifacts');

    const publish = await text('.github/workflows/publish.yml');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('npm publish --provenance');
    expect(publish).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/u);
  });

  it('contains no workstation path or private MCP label fixtures', async () => {
    const validation = await text('packages/mcp-client/src/validation.test.ts');
    const contracts = await text('apps/cli/tests/commands/contracts.test.ts');
    const bootstrap = await text('apps/cli/tests/commands/bootstrap.test.ts');
    expect(`${validation}\n${contracts}\n${bootstrap}`).not.toMatch(/\/home\/legrand|9octopus/u);
  });

  it('keeps local links in public Markdown documents valid', async () => {
    const documents = [
      'README.md',
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'SUPPORT.md',
      'docs/architecture.md',
      'docs/configuration.md',
      'docs/mcp.md',
      'docs/releasing.md',
      'docs/security.md',
      'docs/testing.md',
      'docs/troubleshooting.md',
    ];
    for (const document of documents) {
      const source = await text(document);
      for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1];
        if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue;
        const file = target.split('#', 1)[0];
        if (file === undefined || file.length === 0) continue;
        await expect(access(path.resolve(path.dirname(document), file))).resolves.toBeUndefined();
      }
    }
  });
});
