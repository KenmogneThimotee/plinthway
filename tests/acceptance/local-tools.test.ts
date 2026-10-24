import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { asExecutionId, asSessionId, type ToolCall } from '@plinthway/shared';

import { CompositeToolProvider, ToolRunner } from '../../packages/agent-core/src/index.js';
import { FilesystemToolProvider, ShellToolProvider } from '../../packages/local-tools/src/index.js';
import { ApprovalBroker, PolicyEngine } from '../../packages/policy/src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native local tools acceptance', () => {
  it('enforces workspace containment and approval policy across filesystem and shell tools', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'plinthway-local-tools-'));
    roots.push(workspace);
    await writeFile(path.join(workspace, 'ordinary.txt'), 'safe read', 'utf8');
    await writeFile(path.join(workspace, '.env'), 'SECRET=value', 'utf8');

    const filesystem = await FilesystemToolProvider.create({ workspace });
    const shell = await ShellToolProvider.create({
      workspace,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' },
    });
    const tools = new CompositeToolProvider([filesystem, shell]);
    const prompt = vi.fn().mockResolvedValue('allow-once');
    const runner = new ToolRunner({
      policy: new PolicyEngine({
        enabledServers: [],
        defaultPolicy: 'deny',
        rules: [
          { tool: 'filesystem.write_text', action: 'ask' },
          { tool: 'filesystem.remove', action: 'deny' },
          { tool: 'shell.run', action: 'ask' },
        ],
        tools: tools.listTools(),
      }),
      approvals: new ApprovalBroker({ prompt, persist: vi.fn() }),
      mcp: tools,
      sessionId: asSessionId('session-local-tools'),
      executionId: asExecutionId('execution-local-tools'),
      profileGenerationId: 'generation-local-tools',
      timeoutMs: 2_000,
    });
    const run = (call: ToolCall) => runner.run(call, new AbortController().signal);

    await expect(
      run({
        callId: 'read',
        toolName: 'filesystem.read_text',
        input: { path: 'ordinary.txt' },
      }),
    ).resolves.toMatchObject({
      decision: { action: 'allow' },
      result: { isError: false, content: { text: 'safe read' } },
    });
    expect(prompt).not.toHaveBeenCalled();

    await expect(
      run({
        callId: 'write',
        toolName: 'filesystem.write_text',
        input: { path: 'created.txt', content: 'approved write', mode: 'create' },
      }),
    ).resolves.toMatchObject({ decision: { action: 'ask' }, result: { isError: false } });
    await expect(readFile(path.join(workspace, 'created.txt'), 'utf8')).resolves.toBe(
      'approved write',
    );

    await expect(
      run({
        callId: 'shell',
        toolName: 'shell.run',
        input: {
          program: process.execPath,
          args: [
            '-e',
            "const fs = require('node:fs'); const path = require('node:path'); fs.writeSync(1, path.basename(process.cwd()))",
          ],
        },
      }),
    ).resolves.toMatchObject({
      decision: { action: 'ask' },
      result: { isError: false, content: { stdout: path.basename(workspace) } },
    });

    await expect(
      run({
        callId: 'deny',
        toolName: 'filesystem.remove',
        input: { path: 'ordinary.txt' },
      }),
    ).resolves.toMatchObject({
      decision: { action: 'deny' },
      result: { isError: true, content: { code: 'TOOL_DENIED' } },
    });
    await expect(readFile(path.join(workspace, 'ordinary.txt'), 'utf8')).resolves.toBe('safe read');

    await expect(
      run({
        callId: 'sensitive',
        toolName: 'filesystem.read_text',
        input: { path: '.env' },
      }),
    ).resolves.toMatchObject({
      decision: { action: 'ask', reason: 'risk-floor' },
      result: { isError: false, content: { text: 'SECRET=value' } },
    });

    await expect(
      run({
        callId: 'escape',
        toolName: 'filesystem.read_text',
        input: { path: '../outside.txt' },
      }),
    ).resolves.toMatchObject({
      decision: { action: 'allow' },
      result: { isError: true, content: { code: 'TOOL_DENIED' } },
    });
    expect(prompt).toHaveBeenCalledTimes(3);
  });
});
