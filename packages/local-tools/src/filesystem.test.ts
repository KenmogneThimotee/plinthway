import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemToolProvider } from './filesystem.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(): Promise<{ readonly root: string; readonly tools: FilesystemToolProvider }> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-'));
  cleanup.push(root);
  return { root, tools: await FilesystemToolProvider.create({ workspace: root }) };
}

describe('FilesystemToolProvider', () => {
  it('publishes the complete catalog with safe intrinsic policies', async () => {
    const { tools } = await setup();
    const catalog = tools.listTools();

    expect(catalog.map((tool) => tool.name)).toEqual([
      'filesystem.create_directory',
      'filesystem.glob',
      'filesystem.list',
      'filesystem.move',
      'filesystem.read_text',
      'filesystem.remove',
      'filesystem.search_text',
      'filesystem.stat',
      'filesystem.write_text',
    ]);
    expect(catalog.find((tool) => tool.name === 'filesystem.read_text')).toMatchObject({
      source: { kind: 'builtin', id: 'filesystem' },
      intrinsicAction: 'allow',
      annotations: { readOnlyHint: true },
    });
    expect(catalog.find((tool) => tool.name === 'filesystem.write_text')).toMatchObject({
      intrinsicAction: 'ask',
      annotations: { readOnlyHint: false },
    });
  });

  it('reads line ranges and rejects binary files', async () => {
    const { root, tools } = await setup();
    await writeFile(path.join(root, 'notes.txt'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([1, 0, 2]));

    await expect(
      tools.invoke(
        'filesystem.read_text',
        { path: 'notes.txt', startLine: 2, maxLines: 1 },
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({
      content: { path: 'notes.txt', text: 'two', startLine: 2, endLine: 2, truncated: true },
      isError: false,
    });
    await expect(
      tools.invoke('filesystem.read_text', { path: 'binary.dat' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('lists and stats entries without exposing hidden names by default', async () => {
    const { root, tools } = await setup();
    await Promise.all([
      writeFile(path.join(root, 'z.txt'), 'z', 'utf8'),
      writeFile(path.join(root, 'a.txt'), 'a', 'utf8'),
      writeFile(path.join(root, '.env'), 'secret', 'utf8'),
      mkdir(path.join(root, 'folder')),
    ]);

    const listed = await tools.invoke('filesystem.list', { path: '.' }, { timeoutMs: 100 });
    expect(listed.content).toMatchObject({
      entries: [
        { name: 'a.txt', path: 'a.txt', type: 'file' },
        { name: 'folder', path: 'folder', type: 'directory' },
        { name: 'z.txt', path: 'z.txt', type: 'file' },
      ],
      truncated: false,
    });
    await expect(
      tools.invoke('filesystem.stat', { path: 'a.txt' }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ content: { path: 'a.txt', type: 'file', size: 1 } });
  });

  it('creates, overwrites, moves, and removes workspace entries explicitly', async () => {
    const { root, tools } = await setup();

    await tools.invoke(
      'filesystem.write_text',
      { path: 'nested/file.txt', content: 'first', mode: 'create', createParents: true },
      { timeoutMs: 100 },
    );
    await expect(readFile(path.join(root, 'nested', 'file.txt'), 'utf8')).resolves.toBe('first');
    await expect(
      tools.invoke(
        'filesystem.write_text',
        { path: 'nested/file.txt', content: 'duplicate', mode: 'create' },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await tools.invoke(
      'filesystem.write_text',
      { path: 'nested/file.txt', content: 'second', mode: 'overwrite' },
      { timeoutMs: 100 },
    );
    await tools.invoke(
      'filesystem.move',
      { source: 'nested/file.txt', destination: 'nested/moved.txt' },
      { timeoutMs: 100 },
    );
    await tools.invoke(
      'filesystem.create_directory',
      { path: 'empty', recursive: true },
      { timeoutMs: 100 },
    );
    await tools.invoke(
      'filesystem.remove',
      { path: 'nested', recursive: true },
      { timeoutMs: 100 },
    );
    await expect(readFile(path.join(root, 'nested', 'moved.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('globs and searches literal text with deterministic bounded results', async () => {
    const { root, tools } = await setup();
    await mkdir(path.join(root, 'src'));
    await Promise.all([
      writeFile(path.join(root, 'src', 'a.ts'), 'needle first\n', 'utf8'),
      writeFile(path.join(root, 'src', 'b.ts'), 'second needle\n', 'utf8'),
      writeFile(path.join(root, 'src', 'c.js'), 'needle ignored\n', 'utf8'),
      writeFile(path.join(root, '.hidden.ts'), 'needle secret\n', 'utf8'),
    ]);

    await expect(
      tools.invoke('filesystem.glob', { pattern: '**/*.ts', limit: 1 }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ content: { matches: [{ path: 'src/a.ts' }], truncated: true } });
    await expect(
      tools.invoke(
        'filesystem.search_text',
        { query: 'needle', include: '**/*.ts', limit: 10 },
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({
      content: {
        matches: [
          { path: 'src/a.ts', line: 1, column: 1, text: 'needle first' },
          { path: 'src/b.ts', line: 1, column: 8, text: 'second needle' },
        ],
        truncated: false,
      },
    });
  });

  it('caps text output and total search bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-limits-'));
    cleanup.push(root);
    await Promise.all([
      writeFile(path.join(root, 'large.txt'), 'abcdefghij', 'utf8'),
      writeFile(path.join(root, 'other.txt'), 'needle', 'utf8'),
    ]);
    const tools = await FilesystemToolProvider.create({
      workspace: root,
      limits: { maxTextBytes: 5, maxSearchBytes: 10 },
    });

    await expect(
      tools.invoke('filesystem.read_text', { path: 'large.txt' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(
      tools.invoke(
        'filesystem.search_text',
        { query: 'needle', include: '**/*.txt' },
        { timeoutMs: 100 },
      ),
    ).resolves.toMatchObject({ content: { truncated: true, scannedBytes: 10 } });
  });

  it('escalates hidden and sensitive reads through invocation descriptions', async () => {
    const { root, tools } = await setup();
    await Promise.all([
      writeFile(path.join(root, '.env'), 'secret', 'utf8'),
      writeFile(path.join(root, 'ordinary.txt'), 'ordinary', 'utf8'),
    ]);

    await expect(
      tools.describeInvocation('filesystem.read_text', { path: '.env' }),
    ).resolves.toMatchObject({
      riskFloor: 'ask',
      targets: [path.join(root, '.env')],
      sideEffects: 'may disclose sensitive workspace contents',
    });
    await expect(
      tools.describeInvocation('filesystem.read_text', { path: 'ordinary.txt' }),
    ).resolves.toMatchObject({ riskFloor: 'allow' });
  });

  it('escalates aliases, hidden listings, and searches that can disclose sensitive files', async () => {
    const { root, tools } = await setup();
    await Promise.all([
      writeFile(path.join(root, '.env'), 'secret', 'utf8'),
      writeFile(path.join(root, 'id_rsa'), 'private', 'utf8'),
    ]);
    await symlink(path.join(root, '.env'), path.join(root, 'environment'));

    await expect(
      tools.describeInvocation('filesystem.read_text', { path: 'environment' }),
    ).resolves.toMatchObject({ riskFloor: 'ask' });
    await expect(
      tools.describeInvocation('filesystem.list', { path: '.', includeHidden: true }),
    ).resolves.toMatchObject({ riskFloor: 'ask' });
    await expect(
      tools.describeInvocation('filesystem.search_text', {
        base: '.',
        query: 'private',
        include: '**/*',
      }),
    ).resolves.toMatchObject({ riskFloor: 'ask' });
  });

  it('does not disclose a file swapped to an external symlink after validation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-race-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-outside-'));
    cleanup.push(root, outside);
    const target = path.join(root, 'notes.txt');
    await writeFile(target, 'inside', 'utf8');
    await writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
    let swapped = false;
    const tools = await FilesystemToolProvider.create({
      workspace: root,
      testHooks: {
        afterPathResolution: async (operation, resolved) => {
          if (operation !== 'read_text' || swapped) return;
          swapped = true;
          await rename(resolved, `${resolved}.original`);
          await symlink(path.join(outside, 'secret.txt'), resolved);
        },
      },
    });

    await expect(
      tools.invoke('filesystem.read_text', { path: 'notes.txt' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('rejects directory swaps before traversal or mutation can escape the workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-dir-race-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-dir-outside-'));
    cleanup.push(root, outside);
    await mkdir(path.join(root, 'target'));
    await writeFile(path.join(root, 'target', 'inside.txt'), 'inside', 'utf8');
    await writeFile(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
    const swapped = new Set<string>();
    const tools = await FilesystemToolProvider.create({
      workspace: root,
      testHooks: {
        afterPathResolution: async (operation, resolved) => {
          if (swapped.has(operation)) return;
          swapped.add(operation);
          const swapTarget = operation === 'write_text' ? path.dirname(resolved) : resolved;
          await rename(swapTarget, `${swapTarget}.${operation}.original`);
          await symlink(outside, swapTarget);
        },
      },
    });

    await expect(
      tools.invoke('filesystem.glob', { base: 'target', pattern: '**/*' }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });

    await rm(path.join(root, 'target'));
    await rename(path.join(root, 'target.glob.original'), path.join(root, 'target'));
    await expect(
      tools.invoke(
        'filesystem.write_text',
        { path: 'target/new.txt', content: 'new', mode: 'create' },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(readFile(path.join(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects identical and overlapping overwrite moves without deleting the source', async () => {
    const { root, tools } = await setup();
    await writeFile(path.join(root, 'same.txt'), 'same', 'utf8');
    await mkdir(path.join(root, 'tree', 'child'), { recursive: true });
    await writeFile(path.join(root, 'tree', 'child', 'value.txt'), 'value', 'utf8');

    await expect(
      tools.invoke(
        'filesystem.move',
        { source: 'same.txt', destination: 'same.txt', overwrite: true },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(readFile(path.join(root, 'same.txt'), 'utf8')).resolves.toBe('same');

    await expect(
      tools.invoke(
        'filesystem.move',
        { source: 'tree/child', destination: 'tree', overwrite: true },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(readFile(path.join(root, 'tree', 'child', 'value.txt'), 'utf8')).resolves.toBe(
      'value',
    );

    await writeFile(path.join(root, 'linked-source.txt'), 'linked', 'utf8');
    await link(path.join(root, 'linked-source.txt'), path.join(root, 'linked-destination.txt'));
    await expect(
      tools.invoke(
        'filesystem.move',
        {
          source: 'linked-source.txt',
          destination: 'linked-destination.txt',
          overwrite: true,
        },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(readFile(path.join(root, 'linked-source.txt'), 'utf8')).resolves.toBe('linked');
    await expect(readFile(path.join(root, 'linked-destination.txt'), 'utf8')).resolves.toBe(
      'linked',
    );
  });

  it('restores an overwrite destination if the move cannot be committed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-filesystem-move-rollback-'));
    cleanup.push(root);
    await writeFile(path.join(root, 'source.txt'), 'source', 'utf8');
    await writeFile(path.join(root, 'destination.txt'), 'destination', 'utf8');
    const tools = await FilesystemToolProvider.create({
      workspace: root,
      testHooks: {
        beforeMoveCommit: () => Promise.reject(new Error('injected move failure')),
      },
    });

    await expect(
      tools.invoke(
        'filesystem.move',
        { source: 'source.txt', destination: 'destination.txt', overwrite: true },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(readFile(path.join(root, 'source.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(path.join(root, 'destination.txt'), 'utf8')).resolves.toBe('destination');
  });
});
