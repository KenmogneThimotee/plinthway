import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isIgnorableStdinError, ShellToolProvider } from './shell.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(options: { readonly maxOutputBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'plinthway-shell-'));
  cleanup.push(root);
  const tools = await ShellToolProvider.create({
    workspace: root,
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SECRET_TOKEN: 'must-not-leak',
      LANG: 'C',
    },
    ...(options.maxOutputBytes === undefined
      ? {}
      : { limits: { maxOutputBytes: options.maxOutputBytes } }),
  });
  return { root: await realpath(root), tools };
}

describe('ShellToolProvider', () => {
  it('ignores platform pipe errors after a child closes stdin', () => {
    expect(isIgnorableStdinError({ code: 'EPIPE' })).toBe(true);
    expect(isIgnorableStdinError({ code: 'ERR_STREAM_DESTROYED' })).toBe(true);
    expect(isIgnorableStdinError({ code: 'EOF' })).toBe(true);
    expect(isIgnorableStdinError({ code: 'EACCES' })).toBe(false);
  });

  it('publishes one approval-gated open-world tool', async () => {
    const { tools } = await setup();
    expect(tools.listTools()).toHaveLength(1);
    expect(tools.listTools()[0]).toMatchObject({
      name: 'shell.run',
      source: { kind: 'builtin', id: 'shell' },
      intrinsicAction: 'ask',
      annotations: { readOnlyHint: false, openWorldHint: true },
    });
    await expect(tools.describeInvocation('shell.run', { command: 'pwd' })).resolves.toMatchObject({
      riskFloor: 'ask',
      sideEffects:
        'runs a local process with your OS filesystem and network authority; it is not sandboxed',
    });
  });

  it('requires exactly one of command or program mode', async () => {
    const { tools } = await setup();
    await expect(tools.invoke('shell.run', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'TOOL_ARGUMENTS_INVALID',
    });
    await expect(
      tools.invoke(
        'shell.run',
        { command: 'pwd', program: process.execPath, args: [] },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
  });

  it('runs direct argv mode in a workspace-contained cwd with a sanitized environment', async () => {
    const { root, tools } = await setup();
    await mkdir(path.join(root, 'nested'));
    const script = [
      "require('node:fs').writeSync(1, JSON.stringify({",
      'cwd: process.cwd(),',
      'workspace: process.env.PLINTHWAY_WORKSPACE,',
      'secret: process.env.SECRET_TOKEN ?? null,',
      '}));',
    ].join('');

    const result = await tools.invoke(
      'shell.run',
      { program: process.execPath, args: ['-e', script], cwd: 'nested' },
      { timeoutMs: 2_000 },
    );

    expect(result).toMatchObject({
      isError: false,
      content: {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
    expect(JSON.parse((result.content as { stdout: string }).stdout)).toEqual({
      cwd: path.join(root, 'nested'),
      workspace: root,
      secret: null,
    });
  });

  it('runs command-string mode through the platform shell', async () => {
    const { tools } = await setup();
    const command = `"${process.execPath}" -e "require('node:fs').writeSync(1, 'command-mode')"`;

    await expect(
      tools.invoke('shell.run', { command }, { timeoutMs: 2_000 }),
    ).resolves.toMatchObject({
      isError: false,
      content: { stdout: 'command-mode', exitCode: 0 },
    });
  });

  it('returns bounded output and marks non-zero exits as errors', async () => {
    const { tools } = await setup({ maxOutputBytes: 5 });
    const result = await tools.invoke(
      'shell.run',
      {
        program: process.execPath,
        args: [
          '-e',
          "const fs = require('node:fs'); fs.writeSync(1, 'abcdefghij'); fs.writeSync(2, 'failure'); process.exit(7)",
        ],
      },
      { timeoutMs: 2_000 },
    );

    expect(result).toMatchObject({
      isError: true,
      content: {
        exitCode: 7,
        stdout: 'abcde',
        stderr: 'failu',
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
  });

  it('writes bounded stdin to the child', async () => {
    const { tools } = await setup();
    await expect(
      tools.invoke(
        'shell.run',
        {
          program: process.execPath,
          args: ['-e', "const fs = require('node:fs'); fs.writeSync(1, fs.readFileSync(0))"],
          stdin: 'hello',
        },
        { timeoutMs: 2_000 },
      ),
    ).resolves.toMatchObject({ content: { stdout: 'hello' }, isError: false });
  });

  it('handles a child closing stdin before a bounded payload is written', async () => {
    const { tools } = await setup();
    await expect(
      tools.invoke(
        'shell.run',
        {
          program: process.execPath,
          args: ['-e', 'process.exit(0)'],
          stdin: 'x'.repeat(1024 * 1024),
        },
        { timeoutMs: 2_000 },
      ),
    ).resolves.toMatchObject({ content: { exitCode: 0 }, isError: false });
  });

  it.skipIf(process.platform === 'win32')(
    'kills descendant processes when the invocation times out',
    async () => {
      const { root, tools } = await setup();
      const sentinel = path.join(root, 'descendant-finished');
      const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'), 500)`;
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        'setInterval(() => {}, 1000);',
      ].join('');

      await expect(
        tools.invoke(
          'shell.run',
          { program: process.execPath, args: ['-e', parentScript] },
          { timeoutMs: 50 },
        ),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, 650));
      await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills the process group when the direct child exits before timeout',
    async () => {
      const { root, tools } = await setup();
      const sentinel = path.join(root, 'orphan-finished');
      const childScript = [
        "process.on('SIGTERM', () => {});",
        `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'); process.exit(0); }, 800);`,
      ].join('');
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(childScript)}], { stdio: 'inherit' });`,
      ].join('');
      const startedAt = Date.now();

      await expect(
        tools.invoke(
          'shell.run',
          { program: process.execPath, args: ['-e', parentScript] },
          { timeoutMs: 100 },
        ),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(700);
      await new Promise((resolve) => setTimeout(resolve, 850));
      await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('terminates execution when the invocation signal is cancelled', async () => {
    const { tools } = await setup();
    const controller = new AbortController();
    const execution = tools.invoke(
      'shell.run',
      { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      { timeoutMs: 2_000, signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(execution).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
