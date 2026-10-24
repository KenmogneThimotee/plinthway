import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { startMockLlmServer } from '../mocks/llm-server.js';

const execute = promisify(execFile);
const roots: string[] = [];
const binary = path.resolve('apps/cli/dist/main.js');

async function cli(root: string, arguments_: readonly string[]) {
  return execute(process.execPath, [binary, ...arguments_], {
    env: {
      ...process.env,
      PLINTHWAY_HOME: root,
      HARNESS_HOME: path.join(root, '.legacy-harness'),
      NO_PROXY: '127.0.0.1,localhost',
    },
    timeout: 10_000,
  });
}

async function files(directory: string): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(resolved)));
    else result.push(resolved);
  }
  return result;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built CLI end to end', () => {
  it('self-initializes a clean home with a selected default profile', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-e2e-'));
    roots.push(root);
    const listed = await cli(root, ['--json', 'profile', 'list']);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id: 'default', model: { fallback: [], parameters: {} } }),
    ]);
    await expect(cli(root, ['--json', 'models', 'list'])).resolves.toMatchObject({
      stdout: '[]\n',
    });
    expect(await readFile(path.join(root, 'config.yaml'), 'utf8')).toContain(
      'https://models.dev/api.json',
    );
    expect(
      await readFile(path.join(root, 'profiles', 'default', 'providers.yaml'), 'utf8'),
    ).toContain('providers: {}');
  });

  it('uses only the explicit loopback mock provider and exposes deterministic failures', async () => {
    const fixture = await startMockLlmServer('text');
    try {
      const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer seeded-canary', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      });
      expect(await response.text()).toContain('hello ');
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.path).toBe('/v1/chat/completions');
    } finally {
      await fixture.close();
    }
  });

  it('leaves no seeded credential canary in files, stdout, or stderr', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plinthway-secret-scan-'));
    roots.push(root);
    const output = await execute(process.execPath, [binary, 'init'], {
      env: {
        ...process.env,
        PLINTHWAY_HOME: root,
        HARNESS_HOME: path.join(root, '.legacy-harness'),
        OPENAI_API_KEY: 'seeded-credential-canary',
        NO_PROXY: '127.0.0.1,localhost',
      },
      timeout: 10_000,
    });
    const artifacts = await files(root);
    const contents = await Promise.all(artifacts.map(async (file) => readFile(file)));
    const haystack = [
      output.stdout,
      output.stderr,
      ...contents.map((value) => value.toString('utf8')),
    ].join('\n');
    expect(haystack).not.toContain('seeded-credential-canary');
  });
});
