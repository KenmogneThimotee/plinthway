import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { asProfileId } from '@plinthway/shared';
import { atomicWriteFile } from '@plinthway/config';

import { FileProfileRepository, isProfileCreationCollision } from './repository.js';
import { createProfileLayout, profile } from './test-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepository(): Promise<{ root: string; repository: FileProfileRepository }> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-profiles-'));
  roots.push(root);
  const layout = await createProfileLayout(root);
  return { root, repository: new FileProfileRepository(layout.profiles) };
}

describe('FileProfileRepository', () => {
  it('recognizes Windows EPERM as a destination collision only when the profile exists', async () => {
    const { repository } = await makeRepository();
    const destination = repository.directoryFor('default');
    await mkdir(destination, { recursive: true });

    await expect(isProfileCreationCollision({ code: 'EPERM' }, destination)).resolves.toBe(true);
    await expect(
      isProfileCreationCollision({ code: 'EPERM' }, repository.directoryFor('missing')),
    ).resolves.toBe(false);
  });

  it('creates exactly one empty default bundle as three files under concurrent startup', async () => {
    const { repository } = await makeRepository();

    const [left, right] = await Promise.all([
      repository.ensureDefaultIfEmpty(),
      repository.ensureDefaultIfEmpty(),
    ]);

    expect(left.profile.id).toBe('default');
    expect(right.profile.id).toBe('default');
    expect((await repository.list()).map((record) => record.profile.id)).toEqual(['default']);
    expect((await stat(repository.pathFor('default'))).isFile()).toBe(true);
    expect(
      (
        await stat(path.join(path.dirname(repository.pathFor('default')), 'providers.yaml'))
      ).isFile(),
    ).toBe(true);
    expect(
      (await stat(path.join(path.dirname(repository.pathFor('default')), 'mcp.yaml'))).isFile(),
    ).toBe(true);
    expect((await repository.get('default')).profile.model.primary).toBeUndefined();
  });

  it('migrates legacy MCP servers that now conflict with built-in tool namespaces', async () => {
    const { repository } = await makeRepository();
    const directory = repository.directoryFor('default');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, 'profile.yaml'),
        stringify({
          ...profile({ id: asProfileId('default'), name: 'Default' }),
          mcp: { enabled: ['filesystem', 'shell'] },
          tools: {
            defaultPolicy: 'deny',
            rules: [
              { tool: 'filesystem.*', action: 'ask' },
              { tool: 'shell.execute', action: 'allow' },
              { tool: 'other.read', action: 'deny' },
            ],
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'providers.yaml'),
        stringify({ schemaVersion: 1, providers: {} }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'mcp.yaml'),
        stringify({
          schemaVersion: 2,
          servers: {
            filesystem: { transport: 'stdio', command: 'filesystem-server' },
            shell: { transport: 'stdio', command: 'shell-server' },
            'filesystem-mcp': { transport: 'stdio', command: 'existing-server' },
          },
          enabled: ['filesystem', 'shell'],
          roots: [],
        }),
        'utf8',
      ),
    ]);

    const migrated = await repository.ensureDefaultIfEmpty();

    expect(migrated.profile.mcp?.enabled).toEqual(['filesystem-mcp-2', 'shell-mcp']);
    expect(migrated.mcp.enabled).toEqual(['filesystem-mcp-2', 'shell-mcp']);
    expect(Object.keys(migrated.mcp.servers).sort()).toEqual([
      'filesystem-mcp',
      'filesystem-mcp-2',
      'shell-mcp',
    ]);
    expect(migrated.profile.tools.rules).toEqual([
      { tool: 'filesystem-mcp-2.*', action: 'ask' },
      { tool: 'shell-mcp.execute', action: 'allow' },
      { tool: 'other.read', action: 'deny' },
    ]);

    const persisted = await new FileProfileRepository(path.dirname(directory)).get('default');
    expect(persisted.profile).toEqual(migrated.profile);
    expect(persisted.mcp).toEqual(migrated.mcp);
  });

  it('finishes migration when the profile was written before the MCP configuration', async () => {
    const { repository } = await makeRepository();
    const directory = repository.directoryFor('default');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, 'profile.yaml'),
        stringify({
          ...profile({ id: asProfileId('default'), name: 'Default' }),
          mcp: { enabled: ['filesystem-mcp'] },
          tools: {
            defaultPolicy: 'deny',
            rules: [{ tool: 'filesystem-mcp.*', action: 'ask' }],
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'providers.yaml'),
        stringify({ schemaVersion: 1, providers: {} }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'mcp.yaml'),
        stringify({
          schemaVersion: 2,
          servers: { filesystem: { transport: 'stdio', command: 'filesystem-server' } },
          enabled: ['filesystem'],
          roots: [],
        }),
        'utf8',
      ),
    ]);

    const migrated = await repository.ensureDefaultIfEmpty();

    expect(migrated.profile.mcp?.enabled).toEqual(['filesystem-mcp']);
    expect(migrated.mcp.enabled).toEqual(['filesystem-mcp']);
    expect(Object.keys(migrated.mcp.servers)).toEqual(['filesystem-mcp']);
  });

  it('repairs migration when the MCP configuration was written before the profile', async () => {
    const { repository } = await makeRepository();
    const directory = repository.directoryFor('default');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, 'profile.yaml'),
        stringify({
          ...profile({ id: asProfileId('default'), name: 'Default' }),
          mcp: { enabled: ['filesystem'] },
          tools: {
            defaultPolicy: 'deny',
            rules: [{ tool: 'filesystem.*', action: 'ask' }],
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'providers.yaml'),
        stringify({ schemaVersion: 1, providers: {} }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'mcp.yaml'),
        stringify({
          schemaVersion: 2,
          servers: { 'filesystem-mcp': { transport: 'stdio', command: 'filesystem-server' } },
          enabled: ['filesystem-mcp'],
          roots: [],
        }),
        'utf8',
      ),
    ]);

    const migrated = await repository.ensureDefaultIfEmpty();

    expect(migrated.profile.mcp?.enabled).toEqual(['filesystem-mcp']);
    expect(migrated.profile.tools.rules).toEqual([{ tool: 'filesystem-mcp.*', action: 'ask' }]);
    expect(migrated.mcp.enabled).toEqual(['filesystem-mcp']);
    expect(Object.keys(migrated.mcp.servers)).toEqual(['filesystem-mcp']);
  });

  it('writes the profile first and restores it when the MCP migration write fails', async () => {
    const { repository } = await makeRepository();
    const directory = repository.directoryFor('default');
    await mkdir(directory, { recursive: true });
    const profilePath = path.join(directory, 'profile.yaml');
    const mcpPath = path.join(directory, 'mcp.yaml');
    await Promise.all([
      writeFile(
        profilePath,
        stringify({
          ...profile({ id: asProfileId('default'), name: 'Default' }),
          mcp: { enabled: ['filesystem'] },
        }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'providers.yaml'),
        stringify({ schemaVersion: 1, providers: {} }),
        'utf8',
      ),
      writeFile(
        mcpPath,
        stringify({
          schemaVersion: 2,
          servers: { filesystem: { transport: 'stdio', command: 'filesystem-server' } },
          enabled: ['filesystem'],
          roots: [],
        }),
        'utf8',
      ),
    ]);
    const originalProfile = await readFile(profilePath, 'utf8');
    const originalMcp = await readFile(mcpPath, 'utf8');
    const writes: string[] = [];
    const failing = new FileProfileRepository(path.dirname(directory), async (file, contents) => {
      writes.push(path.basename(file));
      if (file === mcpPath && String(contents).includes('filesystem-mcp')) {
        throw new Error('MCP write failed');
      }
      await atomicWriteFile(file, contents);
    });

    await expect(failing.ensureDefaultIfEmpty()).rejects.toThrow('MCP write failed');

    expect(writes).toEqual(['profile.yaml', 'mcp.yaml', 'profile.yaml']);
    expect(await readFile(profilePath, 'utf8')).toBe(originalProfile);
    expect(await readFile(mcpPath, 'utf8')).toBe(originalMcp);
  });

  it('does not hide unrelated schema errors while migrating reserved MCP ids', async () => {
    const { repository } = await makeRepository();
    const directory = repository.directoryFor('default');
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, 'profile.yaml'),
        stringify({
          ...profile({ id: asProfileId('default'), name: 'Default' }),
          mcp: { enabled: ['filesystem', 42] },
        }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'providers.yaml'),
        stringify({ schemaVersion: 1, providers: {} }),
        'utf8',
      ),
      writeFile(
        path.join(directory, 'mcp.yaml'),
        stringify({
          schemaVersion: 2,
          servers: { filesystem: { transport: 'stdio', command: 'filesystem-server' } },
          enabled: ['filesystem', 42],
          roots: [],
        }),
        'utf8',
      ),
    ]);

    await expect(repository.ensureDefaultIfEmpty()).rejects.toMatchObject({
      code: 'PROFILE_INVALID',
    });
  });

  it('creates, reads, updates, lists in ID order, and deletes profiles', async () => {
    const { repository } = await makeRepository();
    await repository.create(profile({ id: asProfileId('research'), name: 'Research' }));
    await repository.create(profile());
    expect((await repository.list()).map((record) => record.profile.id)).toEqual([
      'coding',
      'research',
    ]);
    await repository.update('coding', profile({ name: 'Updated' }));
    expect((await repository.get('coding')).profile.name).toBe('Updated');
    await repository.delete('coding');
    await expect(repository.get('coding')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });

  it('rejects duplicates, traversal, malformed YAML, unknown keys, and ID/file mismatches', async () => {
    const { repository } = await makeRepository();
    await repository.create(profile());
    await expect(repository.create(profile())).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    await expect(repository.get('../coding')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });

    await mkdir(path.dirname(repository.pathFor('broken')), { recursive: true });
    await writeFile(repository.pathFor('broken'), 'schemaVersion: [', 'utf8');
    await expect(repository.get('broken')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    await mkdir(path.dirname(repository.pathFor('unknown')), { recursive: true });
    await writeFile(
      repository.pathFor('unknown'),
      `${stringify(profile({ id: asProfileId('unknown') }))}extra: true\n`,
      'utf8',
    );
    await expect(repository.get('unknown')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    await mkdir(path.dirname(repository.pathFor('wrong')), { recursive: true });
    await writeFile(repository.pathFor('wrong'), stringify(profile()), 'utf8');
    await expect(repository.get('wrong')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });

  it('does not replace the original file when an update cannot be serialized', async () => {
    const { repository } = await makeRepository();
    await repository.create(profile());
    const before = await readFile(repository.pathFor('coding'), 'utf8');
    await expect(
      repository.update('coding', { ...profile(), name: undefined } as never),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    expect(await readFile(repository.pathFor('coding'), 'utf8')).toBe(before);
  });

  it('restores providers when the paired profile write fails', async () => {
    const { repository } = await makeRepository();
    await repository.create(profile());
    const before = await repository.get('coding');
    const failing = new FileProfileRepository(
      path.dirname(repository.directoryFor('coding')),
      async (file, contents) => {
        if (file.endsWith('profile.yaml') && String(contents).includes('acme/chat')) {
          throw new Error('profile write failed');
        }
        await atomicWriteFile(file, contents);
      },
    );

    await expect(
      failing.updateProviderSelection(
        'coding',
        {
          schemaVersion: 1,
          providers: {
            acme: {
              adapter: 'openai-compatible',
              baseURL: 'https://api.acme.test/v1',
              auth: { mode: 'none' },
              models: { chat: { name: 'Chat' } },
            },
          },
        },
        {
          ...before.profile,
          model: { ...before.profile.model, primary: 'acme/chat' },
        },
      ),
    ).rejects.toThrow('profile write failed');

    const after = await repository.get('coding');
    expect(after.providers).toEqual(before.providers);
    expect(after.profile.model).toEqual(before.profile.model);
  });
});
