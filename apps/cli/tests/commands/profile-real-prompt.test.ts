import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as InquirerPrompts from '@inquirer/prompts';
import { PlinthwayError } from '@plinthway/shared';

const prompt = vi.hoisted(() => ({
  input: undefined as unknown as PassThrough,
  output: undefined as unknown as PassThrough,
  abort: undefined as unknown as AbortController,
}));

vi.mock('@inquirer/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof InquirerPrompts>();
  return {
    ...actual,
    input: (
      config: Parameters<typeof actual.input>[0],
      context?: Parameters<typeof actual.input>[1],
    ) => {
      if (config.message === 'Profile ID') return Promise.resolve('local');
      if (config.message === 'Profile name') return Promise.resolve('Local');
      return actual.input(
        { ...config, default: 'openai/gpt-test' },
        {
          ...context,
          input: prompt.input,
          output: prompt.output,
          signal:
            context?.signal === undefined
              ? prompt.abort.signal
              : AbortSignal.any([context.signal, prompt.abort.signal]),
        },
      );
    },
  };
});

import { runCli, type CliApplication, type CliContext } from '../../src/application.js';

async function waitForOutput(output: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Prompt did not render: ${text}`);
}

beforeEach(() => {
  prompt.input = new PassThrough();
  Object.assign(prompt.input, { isTTY: true, setRawMode: () => prompt.input });
  emitKeypressEvents(prompt.input);
  prompt.output = new PassThrough();
  Object.assign(prompt.output, { isTTY: true, columns: 120, rows: 40 });
  prompt.abort = new AbortController();
});

afterEach(() => {
  prompt.abort.abort(new Error('test cleanup'));
  prompt.input.destroy();
  prompt.output.destroy();
});

describe('interactive profile creation with real prompts', () => {
  it('settles through normal CLI error handling when model validation rejects', async () => {
    let rendered = '';
    prompt.output.on('data', (chunk: Buffer) => {
      rendered += chunk.toString('utf8');
    });
    let stderr = '';
    const createProfile = vi.fn().mockResolvedValue(undefined);
    const application = {
      listProfiles: vi.fn().mockResolvedValue([]),
      validateProfile: vi
        .fn()
        .mockRejectedValue(new PlinthwayError('REGISTRY_UNAVAILABLE', 'Model catalog unavailable')),
      createProfile,
    } as unknown as CliApplication;
    const context: CliContext = {
      application,
      stdout: { write: () => undefined },
      stderr: { write: (value) => (stderr += value) },
      stdin: { isTTY: true } as NodeJS.ReadStream,
      env: {},
      initializeHome: vi.fn().mockResolvedValue(undefined),
    };

    const command = runCli(['profile', 'create'], context);
    await waitForOutput(() => rendered, 'Primary model');
    prompt.input.emit('keypress', '\r', { name: 'return' });

    const outcome = await Promise.race([
      command,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => {
          resolve('pending');
        }, 250);
      }),
    ]);
    if (outcome === 'pending') prompt.abort.abort(new Error('prompt remained pending'));
    await command;

    expect(outcome).toBe(4);
    expect(stderr).toBe('REGISTRY_UNAVAILABLE: Model catalog unavailable\n');
    expect(createProfile).not.toHaveBeenCalled();
  });
});
