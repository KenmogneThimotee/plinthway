import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspacePathPolicy, isSensitiveWorkspacePath } from './path-policy.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function workspace(): Promise<{ readonly root: string; readonly outside: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'plinthway-path-policy-'));
  cleanup.push(parent);
  const rawRoot = path.join(parent, 'workspace');
  const rawOutside = path.join(parent, 'outside');
  await Promise.all([mkdir(rawRoot), mkdir(rawOutside)]);
  const [root, outside] = await Promise.all([realpath(rawRoot), realpath(rawOutside)]);
  return { root, outside };
}

describe('WorkspacePathPolicy', () => {
  it('normalizes relative and contained absolute paths', async () => {
    const { root } = await workspace();
    await writeFile(path.join(root, 'notes.txt'), 'hello', 'utf8');
    const policy = await WorkspacePathPolicy.create(root);

    await expect(policy.resolve('notes.txt')).resolves.toMatchObject({
      absolute: path.join(root, 'notes.txt'),
      relative: 'notes.txt',
    });
    await expect(policy.resolve(path.join(root, 'notes.txt'))).resolves.toMatchObject({
      absolute: path.join(root, 'notes.txt'),
      relative: 'notes.txt',
    });
  });

  it('rejects lexical traversal outside the workspace', async () => {
    const { root } = await workspace();
    const policy = await WorkspacePathPolicy.create(root);

    await expect(policy.resolve('../outside/secret.txt')).rejects.toMatchObject({
      code: 'TOOL_DENIED',
    });
  });

  it('allows internal symlinks and rejects symlinks that escape', async () => {
    const { root, outside } = await workspace();
    await mkdir(path.join(root, 'real'));
    await writeFile(path.join(root, 'real', 'inside.txt'), 'inside', 'utf8');
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(path.join(root, 'real'), path.join(root, 'internal'));
    await symlink(outside, path.join(root, 'external'));
    const policy = await WorkspacePathPolicy.create(root);

    await expect(policy.resolve('internal/inside.txt')).resolves.toMatchObject({
      absolute: path.join(root, 'real', 'inside.txt'),
    });
    await expect(policy.resolve('external/secret.txt')).rejects.toMatchObject({
      code: 'TOOL_DENIED',
    });
  });

  it('checks the nearest existing parent for a new path', async () => {
    const { root, outside } = await workspace();
    await symlink(outside, path.join(root, 'external'));
    const policy = await WorkspacePathPolicy.create(root);

    await expect(policy.resolve('new/child.txt', { mustExist: false })).resolves.toMatchObject({
      absolute: path.join(root, 'new', 'child.txt'),
    });
    await expect(policy.resolve('external/new.txt', { mustExist: false })).rejects.toMatchObject({
      code: 'TOOL_DENIED',
    });
  });

  it('can prohibit operations on the workspace root', async () => {
    const { root } = await workspace();
    const policy = await WorkspacePathPolicy.create(root);

    await expect(policy.resolve('.', { allowRoot: false })).rejects.toMatchObject({
      code: 'TOOL_DENIED',
    });
  });
});

describe('isSensitiveWorkspacePath', () => {
  it.each([
    ['.env', true],
    ['config/.secrets/value', true],
    ['certificates/server.pem', true],
    ['keys/id_ed25519', true],
    ['.env.example', false],
    ['src/index.ts', false],
  ])('classifies %s', (candidate, expected) => {
    expect(isSensitiveWorkspacePath(candidate)).toBe(expected);
  });
});
