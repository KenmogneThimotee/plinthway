import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { terminateProcessTree } from './process-tree.js';

describe('terminateProcessTree', () => {
  it('settles after terminating a running child process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    const closed = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });

    await terminateProcessTree(child);

    const result = await closed;
    if (process.platform === 'win32') expect(result.code).not.toBe(0);
    else expect(result).toMatchObject({ code: null });
  });
});
