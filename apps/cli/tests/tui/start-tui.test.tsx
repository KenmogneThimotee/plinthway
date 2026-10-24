import { Writable } from 'node:stream';

import type * as InkModule from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ink = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof InkModule>()),
  render: ink.render,
}));

import type { CliApplication } from '../../src/application.js';
import { startTui } from '../../src/tui/app.js';

describe('startTui', () => {
  beforeEach(() => {
    ink.render.mockReset();
  });

  it('flushes the initial render before waiting for the app to exit', async () => {
    const calls: string[] = [];
    ink.render.mockReturnValue({
      waitUntilRenderFlush: vi.fn(() => {
        calls.push('flush');
        return Promise.resolve();
      }),
      waitUntilExit: vi.fn(() => {
        calls.push('exit');
        return Promise.resolve();
      }),
    });

    await startTui({} as CliApplication, {
      stdout: new Writable({
        write: (_chunk, _encoding, callback) => {
          callback();
        },
      }),
    });

    expect(calls).toEqual(['flush', 'exit']);
  });
});
