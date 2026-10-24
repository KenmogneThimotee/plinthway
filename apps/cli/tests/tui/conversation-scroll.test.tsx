import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliApplication } from '../../src/application.js';
import { TuiApp } from '../../src/tui/app.js';
import { Conversation } from '../../src/tui/components/conversation.js';

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

function outputStream(): { stream: NodeJS.WriteStream; read(): string; readRaw(): string } {
  const output = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  output.columns = 80;
  output.rows = 24;
  output.isTTY = true;
  let rendered = '';
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString('utf8');
  });
  return {
    stream: output as unknown as NodeJS.WriteStream,
    read: () => stripVTControlCharacters(rendered),
    readRaw: () => rendered,
  };
}

function inputStream(): NodeJS.ReadStream & { push(chunk: string): boolean } {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  return input as unknown as NodeJS.ReadStream & { push(chunk: string): boolean };
}

describe('conversation scrolling', () => {
  it('moves a mounted, overflowing viewport away from the live edge on PageUp', async () => {
    const output = outputStream();
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      kind: 'system' as const,
      tone: 'normal' as const,
      text: `message ${String(index + 1).padStart(2, '0')}`,
    }));
    const instance = render(<Conversation items={items} height={5} />, {
      stdout: output.stream,
      patchConsole: false,
      interactive: true,
    });
    mounted.push(instance);
    await instance.waitUntilRenderFlush();

    expect(output.read()).not.toContain('history ');

    instance.rerender(
      <Conversation items={items} height={5} scrollRequest={{ id: 1, action: 'page-up' }} />,
    );
    await instance.waitUntilRenderFlush();

    expect(output.read()).toContain('history ');
  });

  it('scrolls conversation history when the terminal reports a mouse-wheel event', async () => {
    const application = {
      models: { sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }) },
      initialize: vi.fn().mockResolvedValue(undefined),
      prepareMcp: vi.fn().mockResolvedValue(undefined),
      listMcpServers: vi.fn().mockResolvedValue([]),
      listProfiles: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      mcp: undefined,
      approvalPrompts: undefined,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const output = outputStream();
    const error = outputStream();
    const instance = render(<TuiApp application={application} width={80} height={10} />, {
      stdin,
      stdout: output.stream,
      stderr: error.stream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    mounted.push(instance);
    await vi.waitFor(() => {
      expect(output.read()).toContain('Enter send');
      expect(output.readRaw()).toContain('\u001B[?1000h\u001B[?1006h');
    });

    for (let index = 0; index < 10; index += 1) {
      stdin.push('/status');
      await instance.waitUntilRenderFlush();
      stdin.push('\r');
      await instance.waitUntilRenderFlush();
    }
    expect(output.read()).not.toContain('history ');

    stdin.push('\u001B[<64;10;5M');
    await vi.waitFor(() => {
      expect(output.read()).toContain('history ');
    });
    expect(error.read()).toBe('');
  });
});
