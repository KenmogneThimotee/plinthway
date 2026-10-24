import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CatalogCache } from '../../packages/model-registry/src/index.js';
import { startMockLlmServer } from '../mocks/llm-server.js';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installedPlinthway(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly binary: string;
  readonly entry: string;
  readonly tarball: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-installed-'));
  roots.push(root);
  const pack = path.join(root, 'pack');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  await Promise.all([mkdir(pack), mkdir(project), mkdir(home)]);
  await execute('pnpm', ['--filter', 'plinthway', 'pack', '--pack-destination', pack], {
    cwd: path.resolve('.'),
  });
  const tarball = path.join(pack, 'plinthway-0.1.0.tgz');
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'installed-smoke', private: true, version: '1.0.0' }),
  );
  await execute('pnpm', ['add', '--prefer-offline', tarball], { cwd: project, timeout: 60_000 });
  return {
    root,
    home,
    binary: path.join(project, 'node_modules', '.bin', 'plinthway'),
    entry: path.join(project, 'node_modules', 'plinthway', 'dist', 'main.js'),
    tarball,
  };
}

function isolatedEnvironment(installed: { readonly root: string; readonly home: string }) {
  return {
    ...process.env,
    PLINTHWAY_HOME: installed.home,
    HARNESS_HOME: path.join(installed.root, '.legacy-harness'),
  };
}

describe('installed npm package', () => {
  it('contains only publishable runtime artifacts and no workspace dependencies', async () => {
    const installed = await installedPlinthway();
    const listing = (
      await execute('tar', ['-tzf', installed.tarball], { maxBuffer: 2 * 1024 * 1024 })
    ).stdout
      .trim()
      .split('\n');
    expect(listing.some((entry) => entry.startsWith('package/src/'))).toBe(false);
    expect(listing.some((entry) => entry.startsWith('package/tests/'))).toBe(false);
    expect(listing).toContain('package/dist/main.js');
    expect(listing).toContain('package/README.md');

    const manifest = JSON.parse(
      (await execute('tar', ['-xOf', installed.tarball, 'package/package.json'])).stdout,
    ) as { readonly dependencies?: Readonly<Record<string, string>>; readonly license?: string };
    expect(manifest.license).toBe('MIT');
    expect(
      Object.values(manifest.dependencies ?? {}).some((value) => value.startsWith('workspace:')),
    ).toBe(false);
  }, 60_000);

  it('runs version and self-initializes a default profile from a fresh install', async () => {
    const installed = await installedPlinthway();
    const environment = isolatedEnvironment(installed);
    expect(await readFile(installed.entry, 'utf8')).toMatch(/^#!\/usr\/bin\/env node/u);
    expect((await stat(installed.entry)).mode & 0o111).not.toBe(0);
    await expect(
      execute(installed.binary, ['--version'], { env: environment }),
    ).resolves.toMatchObject({ stdout: '0.1.0\n' });
    const profiles = await execute(installed.binary, ['--json', 'profile', 'list'], {
      env: environment,
    });
    expect(profiles.stdout).toContain('"id":"default"');
    await expect(
      execute(installed.binary, ['--json', 'models', 'list'], { env: environment }),
    ).resolves.toMatchObject({ stdout: '[]\n' });
    expect(await readFile(path.join(installed.home, 'config.yaml'), 'utf8')).toContain(
      'models.dev/api.json',
    );
  }, 60_000);

  it('runs when invoked through a global-style executable symlink', async () => {
    const installed = await installedPlinthway();
    const binary = path.join(installed.root, 'plinthway');
    await symlink(installed.entry, binary);

    await expect(
      execute(binary, ['--version'], {
        env: isolatedEnvironment(installed),
      }),
    ).resolves.toMatchObject({ stdout: '0.1.0\n' });
  }, 60_000);

  it('shuts down an installed chat process cleanly on two-stage SIGINT', async () => {
    const installed = await installedPlinthway();
    await execute(installed.binary, ['init'], {
      env: isolatedEnvironment(installed),
    });
    const child = spawn(installed.binary, ['chat'], {
      env: isolatedEnvironment(installed),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    setTimeout(() => child.kill('SIGINT'), 100);
    setTimeout(() => child.kill('SIGINT'), 200);
    await expect(closed).resolves.toSatisfy(
      (code: number | null) => code === 0 || code === 5 || code === null,
    );
  }, 60_000);

  it('keeps an installed chat process alive after mounting in a terminal', async () => {
    const installed = await installedPlinthway();
    const terminalShim = path.join(installed.root, 'terminal-shim.mjs');
    await writeFile(
      terminalShim,
      [
        'Object.defineProperties(process.stdin, { isTTY: { value: true }, isRaw: { value: false, writable: true } });',
        'process.stdin.unref?.();',
        'let inputKeepAlive;',
        'process.stdin.ref = () => { inputKeepAlive ??= setInterval(() => undefined, 60_000); return process.stdin; };',
        'process.stdin.unref = () => { if (inputKeepAlive !== undefined) clearInterval(inputKeepAlive); inputKeepAlive = undefined; return process.stdin; };',
        'process.stdin.setRawMode = (enabled) => { process.stdin.isRaw = enabled; return process.stdin; };',
        'Object.defineProperties(process.stdout, { isTTY: { value: true }, columns: { value: 100 }, rows: { value: 30 } });',
        "Object.defineProperty(process.stderr, 'isTTY', { value: true });",
        '',
      ].join('\n'),
      'utf8',
    );
    const transcript = path.join(installed.root, 'terminal-output.txt');
    const outputFile = await open(transcript, 'w');
    const child = spawn(installed.binary, ['chat'], {
      env: {
        ...process.env,
        PLINTHWAY_HOME: installed.home,
        HARNESS_HOME: path.join(installed.root, '.legacy-harness'),
        NODE_OPTIONS:
          `${process.env['NODE_OPTIONS'] ?? ''} --import=${pathToFileURL(terminalShim).href}`.trim(),
      },
      stdio: ['ignore', outputFile.fd, outputFile.fd],
    });
    await outputFile.close();
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });

    try {
      const exitedEarly = await Promise.race([
        closed.then(() => true),
        delay(2_000).then(() => false),
      ]);
      expect(exitedEarly).toBe(false);
      await vi.waitFor(
        async () => {
          expect(await readFile(transcript, 'utf8')).toContain('Plinthway');
        },
        { timeout: 5_000 },
      );
    } finally {
      child.kill('SIGTERM');
      await Promise.race([closed, delay(2_000)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  }, 60_000);

  it('runs a prompt through the installed binary and a loopback mock provider', async () => {
    const installed = await installedPlinthway();
    const fixture = await startMockLlmServer();
    try {
      const environment = isolatedEnvironment(installed);
      await execute(installed.binary, ['init'], { env: environment });
      await new CatalogCache(path.join(installed.home, 'cache')).commit(
        {
          local: {
            id: 'local',
            name: 'Local',
            models: {
              test: {
                id: 'test',
                name: 'Test',
                limit: { context: 8192, output: 1024 },
                tool_call: true,
                reasoning: false,
                structured_output: false,
              },
            },
          },
        },
        { fetchedAt: Date.now() },
      );
      await writeFile(
        path.join(installed.home, 'profiles', 'default', 'profile.yaml'),
        [
          'schemaVersion: 1',
          'id: default',
          'name: Default',
          'model:',
          '  primary: local/test',
          '  fallback: []',
          '  parameters: {}',
          'mcp:',
          '  enabled: []',
          'tools:',
          '  defaultPolicy: deny',
          '  rules: []',
          'agent:',
          '  maxSteps: 5',
          'session:',
          '  persist: true',
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(installed.home, 'profiles', 'default', 'providers.yaml'),
        [
          'schemaVersion: 1',
          'providers:',
          '  local:',
          '    adapter: openai-compatible',
          `    baseURL: ${fixture.baseUrl}`,
          '    auth:',
          '      mode: none',
          '    models: {}',
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(installed.home, 'profiles', 'default', 'mcp.yaml'),
        ['schemaVersion: 1', 'servers: {}', 'enabled: []', ''].join('\n'),
      );
      const result = await execute(installed.binary, ['run', 'hello'], {
        env: environment,
        timeout: 10_000,
      });
      expect(result.stdout).toContain('hello world');
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
