import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { runCli } from '../../src/application.js';
import { createApplication, prepareSessionDependencies } from '../../src/bootstrap.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI bootstrap', () => {
  it('automatically adopts legacy Harness state before creating a fresh home', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-migration-'));
    roots.push(root);
    const legacyHome = path.join(root, 'legacy');
    const targetHome = path.join(root, 'current');
    const seed = await createApplication({
      env: { PLINTHWAY_HOME: legacyHome },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    await seed.application.initialize();
    await seed.close();
    await rename(
      path.join(legacyHome, 'data', 'plinthway.sqlite'),
      path.join(legacyHome, 'data', 'harness.sqlite'),
    );

    const migrated = await createApplication({
      env: { HARNESS_HOME: legacyHome, PLINTHWAY_HOME: targetHome },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    try {
      await expect(migrated.application.listProfiles()).resolves.toHaveLength(1);
      await expect(
        readFile(path.join(targetHome, 'data', '.migrated-from-harness.json'), 'utf8'),
      ).resolves.toContain('Harness');
      await expect(readFile(path.join(legacyHome, 'config.yaml'), 'utf8')).resolves.toContain(
        'models.dev',
      );
    } finally {
      await migrated.close();
    }
  });

  it('commits a partial MCP snapshot when configured tools are temporarily unavailable', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockResolvedValue({
      tools: [],
      commit,
      rollback,
      releaseSuperseded: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      prepareSessionDependencies({ prepare }, {
        tools: { rules: [{ tool: 'offline.search', action: 'allow' }] },
      } as never),
    ).resolves.toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('creates and selects an empty default profile without requiring init', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    try {
      await expect(bootstrapped.application.initialize()).resolves.toMatchObject({
        id: 'default',
        model: { fallback: [] },
      });
      await expect(bootstrapped.application.listProfiles()).resolves.toHaveLength(1);
      expect(bootstrapped.application.listTools().map(({ name }) => name)).toEqual([
        'filesystem.create_directory',
        'filesystem.glob',
        'filesystem.list',
        'filesystem.move',
        'filesystem.read_text',
        'filesystem.remove',
        'filesystem.search_text',
        'filesystem.stat',
        'filesystem.write_text',
        'shell.run',
      ]);
      await expect(bootstrapped.application.newSession()).rejects.toMatchObject({
        code: 'MODEL_NOT_CONFIGURED',
      });
      expect(await readFile(bootstrapped.paths.config, 'utf8')).toContain('models.dev/api.json');
      expect(
        await readFile(path.join(bootstrapped.paths.profiles, 'default', 'providers.yaml'), 'utf8'),
      ).toContain('providers: {}');
    } finally {
      await bootstrapped.close();
    }
  });

  it('initializes isolated local state and lists models offline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stdout = '';
    let stderr = '';
    try {
      expect(
        await runCli(['init'], {
          application: bootstrapped.application,
          stdout: { write: (value) => (stdout += value) },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);
      expect(await readFile(bootstrapped.paths.config, 'utf8')).toContain('models.dev/api.json');
      stdout = '';
      expect(
        await runCli(['--json', 'models', 'list'], {
          application: bootstrapped.application,
          stdout: { write: (value) => (stdout += value) },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('adds a remote MCP server from its URL alone without connecting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stdout = '';
    let stderr = '';
    try {
      expect(
        await runCli(['mcp', 'add', 'docs', '--url', 'https://mcp.example.com/mcp'], {
          application: bootstrapped.application,
          stdout: { write: (value) => (stdout += value) },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);

      const profileDirectory = path.join(bootstrapped.paths.profiles, 'default');
      const mcp = parse(await readFile(path.join(profileDirectory, 'mcp.yaml'), 'utf8')) as {
        servers: Record<string, unknown>;
        enabled: string[];
      };
      const profile = parse(
        await readFile(path.join(profileDirectory, 'profile.yaml'), 'utf8'),
      ) as {
        mcp: { enabled: string[] };
        tools: { rules: Array<{ tool: string; action: string }> };
      };

      expect(mcp.servers.docs).toEqual({
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        auth: { mode: 'oauth', scopes: [] },
        extensions: {
          tasks: false,
          skills: false,
          apps: false,
          oauthClientCredentials: false,
          enterpriseManagedAuth: false,
        },
      });
      expect(mcp.enabled).toEqual([]);
      expect(profile.mcp.enabled).toEqual([]);
      expect(profile.tools.rules).toContainEqual({ tool: 'docs.*', action: 'ask' });
      expect(stdout).toContain('Added MCP server docs to profile default');
      expect(stdout).toContain('mcp connect docs');
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('adds, lists, updates, and clears a friendly MCP server label', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stdout = '';
    let stderr = '';
    const context = {
      application: bootstrapped.application,
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
      stdin: { isTTY: false } as NodeJS.ReadStream,
      env: { PLINTHWAY_HOME: root },
      initializeHome: bootstrapped.initializeHome,
    };
    const mcpPath = path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml');
    try {
      expect(
        await runCli(
          [
            'mcp',
            'add',
            'docs',
            '--label',
            '  Work Docs  ',
            '--url',
            'https://mcp.example.com/mcp',
          ],
          context,
        ),
      ).toBe(0);
      expect(stdout).toContain('Added MCP server Work Docs (docs)');
      expect(
        (
          parse(await readFile(mcpPath, 'utf8')) as {
            servers: { docs: { label?: string } };
          }
        ).servers.docs.label,
      ).toBe('Work Docs');

      stdout = '';
      expect(await runCli(['mcp', 'list'], context)).toBe(0);
      expect(stdout).toContain('Work Docs (docs)\tdisconnected\tdisabled');

      stdout = '';
      expect(await runCli(['--json', 'mcp', 'list'], context)).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        expect.objectContaining({
          serverId: 'docs',
          label: 'Work Docs',
          enabled: false,
          state: 'disconnected',
        }),
      ]);

      stdout = '';
      expect(await runCli(['mcp', 'label', 'docs', 'Reference Docs'], context)).toBe(0);
      expect(stdout).toContain('Labeled MCP server Reference Docs (docs)');
      expect(
        (
          parse(await readFile(mcpPath, 'utf8')) as {
            servers: { docs: { label?: string } };
          }
        ).servers.docs.label,
      ).toBe('Reference Docs');

      stdout = '';
      expect(await runCli(['mcp', 'label', 'docs', '--clear'], context)).toBe(0);
      expect(stdout).toContain('Cleared label for MCP server docs');
      expect(
        (
          parse(await readFile(mcpPath, 'utf8')) as {
            servers: { docs: { label?: string } };
          }
        ).servers.docs,
      ).not.toHaveProperty('label');
      expect(stderr).toBe('');

      expect(await runCli(['mcp', 'label', 'docs'], context)).toBe(2);
      expect(stderr).toContain('Provide a label or use --clear');
      stderr = '';
      expect(await runCli(['mcp', 'label', 'docs', 'Duplicate', '--clear'], context)).toBe(2);
      expect(stderr).toContain('Choose either a label or --clear');
      stderr = '';
      expect(await runCli(['mcp', 'label', 'docs', 'Docs\u001b[2J'], context)).toBe(2);
      expect(stderr).toContain('MCP server label is invalid');
    } finally {
      await bootstrapped.close();
    }
  });

  it('adds a stdio MCP server from a command after the option separator', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stderr = '';
    try {
      expect(
        await runCli(['mcp', 'add', 'local', '--', process.execPath, 'server.mjs'], {
          application: bootstrapped.application,
          stdout: { write: () => undefined },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);

      const source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      const mcp = parse(source) as { servers: Record<string, unknown>; enabled: string[] };
      expect(mcp.servers.local).toEqual({
        transport: 'stdio',
        command: process.execPath,
        args: ['server.mjs'],
        env: [],
        extensions: {
          tasks: false,
          skills: false,
          apps: false,
          oauthClientCredentials: false,
          enterpriseManagedAuth: false,
        },
      });
      expect(mcp.enabled).toEqual([]);
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('protects an existing MCP server unless replacement is explicit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stderr = '';
    const context = {
      application: bootstrapped.application,
      stdout: { write: () => undefined },
      stderr: { write: (value: string) => (stderr += value) },
      stdin: { isTTY: false } as NodeJS.ReadStream,
      env: { PLINTHWAY_HOME: root },
      initializeHome: bootstrapped.initializeHome,
    };
    try {
      expect(
        await runCli(['mcp', 'add', 'docs', '--url', 'https://one.example.com/mcp'], context),
      ).toBe(0);
      expect(
        await runCli(['mcp', 'add', 'docs', '--url', 'https://two.example.com/mcp'], context),
      ).toBe(2);
      expect(stderr).toContain('MCP server docs already exists');

      expect(
        await runCli(
          ['mcp', 'add', 'docs', '--url', 'https://two.example.com/mcp', '--force'],
          context,
        ),
      ).toBe(0);
      const source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      const mcp = parse(source) as {
        servers: { docs: { url: string } };
        enabled: string[];
      };
      expect(mcp.servers.docs.url).toBe('https://two.example.com/mcp');
      expect(mcp.enabled).toEqual([]);
    } finally {
      await bootstrapped.close();
    }
  });

  it('persists a URL-only loopback-alias MCP server as disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stdout = '';
    let stderr = '';
    try {
      expect(
        await runCli(['mcp', 'add', '--label', '9docs', '--url', 'http://api.local.test/mcp'], {
          application: bootstrapped.application,
          stdout: { write: (value) => (stdout += value) },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);
      expect(stdout).toContain('9docs (mcp-9docs)');
      expect(stdout).toContain('mcp connect mcp-9docs --profile default');

      const source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      const mcp = parse(source) as {
        servers: Record<
          string,
          { label?: string; transport: string; url?: string; auth?: { mode: string } }
        >;
        enabled: string[];
      };
      expect(mcp.servers['mcp-9docs']).toMatchObject({
        label: '9docs',
        transport: 'streamable-http',
        url: 'http://api.local.test/mcp',
        auth: { mode: 'oauth' },
      });
      expect(mcp.enabled).toEqual([]);
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('stores public HTTP MCP configuration without connecting it automatically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stderr = '';
    try {
      expect(
        await runCli(['mcp', 'add', 'unsafe', '--url', 'http://example.com/mcp'], {
          application: bootstrapped.application,
          stdout: { write: () => undefined },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(0);

      const source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      const mcp = parse(source) as { servers: Record<string, unknown>; enabled: string[] };
      expect(mcp.servers).toHaveProperty('unsafe');
      expect(mcp.enabled).toEqual([]);
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('lists configured disconnected servers and persistently connects and disconnects them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stdout = '';
    let stderr = '';
    const context = {
      application: bootstrapped.application,
      stdout: { write: (value: string) => (stdout += value) },
      stderr: { write: (value: string) => (stderr += value) },
      stdin: { isTTY: false } as NodeJS.ReadStream,
      env: { PLINTHWAY_HOME: root },
      initializeHome: bootstrapped.initializeHome,
    };
    try {
      expect(
        await runCli(['mcp', 'add', 'docs', '--url', 'https://mcp.example.com/mcp'], context),
      ).toBe(0);
      stdout = '';

      expect(await runCli(['--json', 'mcp', 'list'], context)).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        expect.objectContaining({ serverId: 'docs', enabled: false, state: 'disconnected' }),
      ]);
      stdout = '';

      expect(await runCli(['mcp', 'connect', 'docs'], context)).toBe(4);
      expect(stderr).toContain('MCP_CONNECTION_FAILED');
      let source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      expect((parse(source) as { enabled: string[] }).enabled).toEqual(['docs']);
      stdout = '';
      stderr = '';

      expect(await runCli(['mcp', 'disconnect', 'docs'], context)).toBe(0);
      source = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'mcp.yaml'),
        'utf8',
      );
      expect((parse(source) as { enabled: string[] }).enabled).toEqual([]);
      const profileSource = await readFile(
        path.join(bootstrapped.paths.profiles, 'default', 'profile.yaml'),
        'utf8',
      );
      expect((parse(profileSource) as { mcp: { enabled: string[] } }).mcp.enabled).toEqual([]);
      expect(stderr).toBe('');
    } finally {
      await bootstrapped.close();
    }
  });

  it('rejects connecting an unknown MCP server', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-cli-'));
    roots.push(root);
    const bootstrapped = await createApplication({
      env: { PLINTHWAY_HOME: root },
      cwd: root,
      homedir: root,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      fetch: () => Promise.reject(new Error('network disabled')),
    });
    let stderr = '';
    try {
      expect(
        await runCli(['mcp', 'connect', 'ghost'], {
          application: bootstrapped.application,
          stdout: { write: () => undefined },
          stderr: { write: (value) => (stderr += value) },
          stdin: { isTTY: false } as NodeJS.ReadStream,
          env: { PLINTHWAY_HOME: root },
          initializeHome: bootstrapped.initializeHome,
        }),
      ).toBe(2);
      expect(stderr).toContain('MCP server ghost is not configured');
    } finally {
      await bootstrapped.close();
    }
  });
});
