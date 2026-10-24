import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

async function manifest(file: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(file, 'utf8')) as PackageManifest;
}

describe('Plinthway package identity', () => {
  it('uses the Plinthway workspace, package, and executable names', async () => {
    const root = await manifest(path.resolve('package.json'));
    const cli = await manifest(path.resolve('apps/cli/package.json'));

    expect(root).toMatchObject({ name: 'plinthway-workspace', private: true });
    expect(cli.name).toBe('plinthway');
    expect(cli.bin).toEqual({ plinthway: 'dist/main.js' });
    expect(cli.bin).not.toHaveProperty('harness');
  });

  it('uses only the private @plinthway scope for workspace packages', async () => {
    const packageFiles = [
      'packages/agent-core/package.json',
      'packages/app-core/package.json',
      'packages/auth/package.json',
      'packages/config/package.json',
      'packages/llm-runtime/package.json',
      'packages/local-tools/package.json',
      'packages/mcp-app-host/package.json',
      'packages/mcp-client/package.json',
      'packages/model-registry/package.json',
      'packages/policy/package.json',
      'packages/profiles/package.json',
      'packages/sessions/package.json',
      'packages/shared/package.json',
    ];

    const manifests = await Promise.all(packageFiles.map((file) => manifest(path.resolve(file))));
    expect(manifests.map(({ name }) => name)).toEqual(
      packageFiles.map((file) => `@plinthway/${path.basename(path.dirname(file))}`),
    );

    for (const value of manifests) {
      expect(value.private).toBe(true);
      expect(Object.keys(value.dependencies ?? {})).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^@harness\//u)]),
      );
      expect(Object.keys(value.devDependencies ?? {})).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^@harness\//u)]),
      );
    }
  });
});
