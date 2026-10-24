import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../../apps/cli/src/bootstrap.js';
import { providerConfiguration } from '../../apps/cli/src/tui/overlays/provider-setup.js';
import { initialStartupState, startupReducer } from '../../apps/cli/src/tui/startup.js';
import { CatalogCache } from '../../packages/model-registry/src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshHome() {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-chat-first-'));
  roots.push(root);
  return root;
}

describe('chat-first configuration acceptance', () => {
  it('creates and selects default state before setup and restores retry after a failed sync', async () => {
    const root = await freshHome();
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      fetch: () => Promise.reject(new TypeError('offline')),
      stdin: { isTTY: false } as NodeJS.ReadStream,
    });
    try {
      await expect(bootstrapped.application.initialize()).resolves.toMatchObject({
        id: 'default',
        model: { fallback: [] },
      });
      await expect(bootstrapped.application.models?.sync()).rejects.toMatchObject({
        code: 'REGISTRY_UNAVAILABLE',
      });
      let startup = startupReducer(initialStartupState(), {
        type: 'failed',
        message: 'offline',
      });
      startup = startupReducer(startup, { type: 'retry' });
      expect(startup).toMatchObject({ phase: 'syncing', attempt: 1 });
    } finally {
      await bootstrapped.close();
    }
  });

  it('continues from a valid cache and persists custom provider metadata without secrets', async () => {
    const root = await freshHome();
    const catalog = JSON.parse(
      await readFile(path.resolve('tests/fixtures/models/valid.json'), 'utf8'),
    ) as unknown;
    await new CatalogCache(path.join(root, 'cache')).commit(catalog, { fetchedAt: 1 });
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      fetch: () => Promise.reject(new TypeError('offline')),
      stdin: { isTTY: false } as NodeJS.ReadStream,
    });
    try {
      await expect(bootstrapped.application.models?.sync()).resolves.toMatchObject({
        source: 'cache',
      });
      const custom = providerConfiguration('custom', 'acme/chat-pro', {
        providerId: 'acme',
        baseURL: 'https://models.acme.test/v1',
        authMode: 'none',
      });
      await bootstrapped.application.configureProvider({
        profileId: 'default',
        ...custom,
      });
      const exported = await bootstrapped.application.exportProfile('default');
      expect(exported.providersYaml).toContain('https://models.acme.test/v1');
      expect(JSON.stringify(exported)).not.toContain('seeded-provider-secret');

      const builtIn = providerConfiguration('openai', 'openai/gpt-test');
      expect(JSON.stringify(builtIn)).not.toContain('seeded-provider-secret');
      expect(builtIn.provider.auth).toEqual({ mode: 'api-key', credential: 'keyring' });
    } finally {
      await bootstrapped.close();
    }
  });
});
