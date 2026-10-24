import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '@plinthway/shared';

import { ProfileCatalog } from './manager.js';
import { FileProfileRepository } from './repository.js';
import {
  createProfileLayout,
  FakeRegistry,
  globalConfig,
  MemoryActiveProfileStore,
  profile,
} from './test-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('effective profile resolution', () => {
  it('builds deterministic immutable snapshots from only allowlisted overrides', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-resolve-'));
    roots.push(root);
    const layout = await createProfileLayout(root);
    const repository = new FileProfileRepository(layout.profiles);
    const config = globalConfig();
    const files = config.mcpServers.files;
    if (files === undefined) throw new Error('Test config must define the files MCP server');
    const catalog = new ProfileCatalog({
      repository,
      config: {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          files: { ...files, label: 'Local Files' },
        },
      },
      registry: new FakeRegistry(),
      activeStore: new MemoryActiveProfileStore(),
      instructionRoots: [layout.instructions, layout.profiles],
      environment: { PUBLIC_NAME: 'safe' },
    });
    await catalog.create(profile());

    const first = await catalog.resolve('coding', {
      workspace: '/work/one',
      model: 'openai/gpt-override',
      persist: false,
      maxSteps: 3,
      toolTimeoutSeconds: 7,
    });
    const second = await catalog.resolve('coding', {
      workspace: '/work/one',
      model: 'openai/gpt-override',
      persist: false,
      maxSteps: 3,
      toolTimeoutSeconds: 7,
    });
    expect(first.generationId).toBe(second.generationId);
    const { generationId, ...snapshotWithoutGeneration } = first;
    expect(generationId).toBe(sha256(canonicalJson(snapshotWithoutGeneration)));
    expect(first).toMatchObject({
      model: { primary: 'openai/gpt-override' },
      agent: { maxSteps: 3, toolTimeoutSeconds: 7 },
      session: { persist: false },
      resolvedInstructions: 'Follow project conventions.\n',
      resolvedMcpServers: [{ id: 'files', args: ['/work/one'] }],
    });
    expect(first.resolvedMcpServers[0]).not.toHaveProperty('label');
    expect('instructionsFile' in first.agent).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools.rules)).toBe(true);

    await catalog.update('coding', profile({ name: 'Changed later' }));
    expect(first.name).toBe('Coding');
    const changed = await catalog.resolve('coding', { workspace: '/work/one' });
    expect(changed.generationId).not.toBe(first.generationId);
  });

  it('rejects non-allowlisted override fields and invalid model overrides', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-resolve-'));
    roots.push(root);
    const layout = await createProfileLayout(root);
    const repository = new FileProfileRepository(layout.profiles);
    const catalog = new ProfileCatalog({
      repository,
      config: globalConfig(),
      registry: new FakeRegistry(),
      activeStore: new MemoryActiveProfileStore(),
      instructionRoots: [layout.instructions, layout.profiles],
      environment: {},
    });
    await catalog.create(profile());

    await expect(
      catalog.resolve('coding', { tools: { defaultPolicy: 'allow' } } as never),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    await expect(catalog.resolve('coding', { model: 'openai/missing' })).rejects.toMatchObject({
      code: 'PROFILE_INVALID',
    });
  });
});
