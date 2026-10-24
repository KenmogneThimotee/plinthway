import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerRedactionSecret } from '@plinthway/shared';

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

describe('sanitized profile export', () => {
  it('contains only redacted source YAML and referenced instruction content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-export-'));
    roots.push(root);
    const layout = await createProfileLayout(root);
    const repository = new FileProfileRepository(layout.profiles);
    const catalog = new ProfileCatalog({
      repository,
      config: globalConfig(),
      registry: new FakeRegistry(),
      activeStore: new MemoryActiveProfileStore(),
      instructionRoots: [layout.instructions, layout.profiles],
      environment: { WORKSPACE: '/secret/workspace' },
    });
    const unregister = registerRedactionSecret('live-secret-value');
    try {
      await catalog.create(profile({ description: 'Use live-secret-value only locally' }));
      const exported = await catalog.exportSanitized('coding');
      const serialized = JSON.stringify(exported);
      expect(exported.profileYaml).toContain('[REDACTED]');
      expect(exported.instructions).toEqual({
        fileName: 'coding.md',
        content: 'Follow project conventions.\n',
      });
      expect(serialized).not.toContain('live-secret-value');
      expect(serialized).not.toContain('/secret/workspace');
      expect(serialized).not.toMatch(/authorization|password|accessToken|profile:.*:provider:/iu);
      expect(serialized).not.toContain('generationId');
    } finally {
      unregister();
    }
  });

  it('replaces local ChatGPT connection IDs structurally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-export-chatgpt-'));
    roots.push(root);
    const layout = await createProfileLayout(root);
    const repository = new FileProfileRepository(layout.profiles);
    const catalog = new ProfileCatalog({
      repository,
      config: globalConfig(),
      registry: new FakeRegistry(),
      activeStore: new MemoryActiveProfileStore(),
      instructionRoots: [layout.instructions, layout.profiles],
      environment: { WORKSPACE: root },
    });
    await catalog.create(profile());
    await catalog.configureProvider('coding', 'chatgpt', {
      adapter: 'openai-chatgpt',
      auth: { mode: 'oauth', service: 'chatgpt', connectionId: 'private-connection-id' },
      models: { 'gpt-test': { name: 'GPT Test', toolCalls: true } },
    });

    const exported = await catalog.exportSanitized('coding');
    expect(exported.providersYaml).toContain('connectionId: local-selection-required');
    expect(exported.providersYaml).not.toContain('private-connection-id');
  });
});
