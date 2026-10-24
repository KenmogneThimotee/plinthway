import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadGlobalConfig } from './loader.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/config',
);

describe('loadGlobalConfig', () => {
  it('merges defaults, YAML, public environment, and allowlisted runtime overrides', async () => {
    const loaded = await loadGlobalConfig({
      configPath: path.join(fixtures, 'valid.yaml'),
      env: { PUBLIC_MCP_URL: 'https://mcp.example.com/api' },
      workspace: '/work/project',
      overrides: { model: 'openai/gpt-test', persist: false, maxSteps: 8 },
    });

    expect(loaded.config.registry.cache).toBe(false);
    expect(loaded.config.registry.refreshIntervalHours).toBe(24);
    expect(loaded.config.mcpServers.files).toMatchObject({ args: ['/work/project'] });
    expect(loaded.config.mcpServers.remote).toMatchObject({
      url: 'https://mcp.example.com/api',
    });
    expect(loaded.runtime).toEqual({
      workspace: '/work/project',
      model: 'openai/gpt-test',
      persist: false,
      maxSteps: 8,
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.config.registry)).toBe(true);
  });

  it('rejects unknown global keys and non-allowlisted runtime overrides', async () => {
    await expect(
      loadGlobalConfig({ configPath: path.join(fixtures, 'unknown-key.yaml') }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    await expect(
      loadGlobalConfig({ overrides: { security: { defaultToolPolicy: 'allow' } } as never }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
