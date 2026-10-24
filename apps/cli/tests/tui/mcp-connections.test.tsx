import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asProfileId, asSessionId, type WorkProfile } from '@plinthway/shared';

import type { CliApplication } from '../../src/application.js';
import { TuiApp } from '../../src/tui/app.js';

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

function profile(): WorkProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('default'),
    name: 'Default',
    model: { primary: 'openai/test', fallback: [], parameters: {} },
    mcp: { enabled: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 5 },
    session: { persist: true },
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

function outputStream(): { stream: NodeJS.WriteStream; read(): string } {
  const output = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = true;
  let rendered = '';
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString('utf8');
  });
  return {
    stream: output as unknown as NodeJS.WriteStream,
    read: () => stripVTControlCharacters(rendered),
  };
}

async function waitForInitialRender(output: { read(): string }): Promise<void> {
  await vi.waitFor(
    () => {
      expect(output.read()).toContain('profile: default');
    },
    { timeout: 5_000 },
  );
}

async function* completion() {
  await Promise.resolve();
  yield { type: 'finish' as const, reason: 'stop' as const };
}

type RunApplication = (
  prompt: string,
  options?: { readonly sessionId?: string; readonly signal?: AbortSignal },
) => Promise<{
  readonly session: { readonly id: ReturnType<typeof asSessionId> };
  readonly events: ReturnType<typeof completion>;
}>;

describe('TUI MCP connections', () => {
  it('completes remote OAuth before reporting a selected server as connected', async () => {
    let enabled = true;
    let state: 'disconnected' | 'auth-required' | 'ready' = 'auth-required';
    const authorize = vi.fn().mockResolvedValue({
      state: 'redirect' as const,
      authorizationUrl: 'https://issuer.example.com/authorize',
      waitForCompletion: () => {
        state = 'ready';
        return Promise.resolve();
      },
    });
    const mcp = {
      authorize,
      listTasks: vi.fn().mockResolvedValue([]),
      listTools: vi.fn().mockReturnValue([]),
      listPrompts: vi.fn().mockReturnValue([]),
      listResources: vi.fn().mockReturnValue([]),
      listSkills: vi.fn().mockReturnValue([]),
      listActiveSkills: vi.fn().mockReturnValue([]),
      listApps: vi.fn().mockReturnValue([]),
      listAppSessions: vi.fn().mockReturnValue([]),
      listEvents: vi.fn().mockReturnValue([]),
      onEvent: vi.fn().mockReturnValue(() => undefined),
      interactions: {
        pending: vi.fn().mockReturnValue([]),
        onRequest: vi.fn().mockReturnValue(() => undefined),
      },
    };
    const prepareMcp = vi.fn().mockResolvedValue(undefined);
    const setMcpServerEnabled = vi
      .fn()
      .mockImplementation((_profileId: string, _serverId: string, next: boolean) => {
        enabled = next;
        return Promise.resolve();
      });
    const application = {
      models: { sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }) },
      mcp,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile()),
      prepareMcp,
      listProfiles: vi.fn().mockResolvedValue([profile()]),
      listSessions: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockImplementation(() =>
        Promise.resolve([
          {
            serverId: 'remote',
            enabled,
            state: enabled ? state : ('disconnected' as const),
            ...(state === 'auth-required' ? { authorization: { state: 'required' as const } } : {}),
          },
        ]),
      ),
      setMcpServerEnabled,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    });
    mounted.push(instance);

    await waitForInitialRender(stdout);
    stdin.push('/mcp');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('› remote · auth-required');
    });
    stdin.push('\r');

    await vi.waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'remote', true);
      expect(authorize).toHaveBeenCalledWith('remote');
      expect(stdout.read()).toContain('› remote · ready');
    });
    expect(stderr.read()).toBe('');
  });

  it('selects a configured server and toggles its persistent connection with Enter', async () => {
    const enabled = new Map([
      ['docs', true],
      ['search', false],
    ]);
    const labels = new Map([
      ['docs', 'Work Docs'],
      ['search', 'Web Search'],
    ]);
    const setMcpServerEnabled = vi
      .fn()
      .mockImplementation((_profileId: string, serverId: string, next: boolean) => {
        enabled.set(serverId, next);
        return Promise.resolve();
      });
    const prepareMcp = vi.fn().mockResolvedValue(undefined);
    const application = {
      models: { sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }) },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile()),
      prepareMcp,
      listProfiles: vi.fn().mockResolvedValue([profile()]),
      listSessions: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockImplementation(() =>
        Promise.resolve(
          [...enabled].map(([serverId, isEnabled]) => ({
            serverId,
            label: labels.get(serverId),
            enabled: isEnabled,
            state: isEnabled ? ('ready' as const) : ('disconnected' as const),
          })),
        ),
      ),
      setMcpServerEnabled,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    });
    mounted.push(instance);

    await waitForInitialRender(stdout);
    stdin.push('/mcp');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('MCP servers');
      expect(stdout.read()).toContain('› Work Docs (docs) · ready');
    });

    stdin.push('\u001B[B');
    await vi.waitFor(() => {
      expect(stdout.read()).toContain('› Web Search (search) · disconnected');
    });
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'search', true);
      expect(stdout.read()).toContain('› Web Search (search) · ready');
    });

    stdin.push('\r');
    await vi.waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'search', false);
    });
    expect(prepareMcp).toHaveBeenCalledTimes(3);
    expect(stderr.read()).toBe('');
  });

  it('persistently connects and disconnects a server with slash commands', async () => {
    let enabled = false;
    const setMcpServerEnabled = vi
      .fn()
      .mockImplementation((_profileId: string, _serverId: string, next: boolean) => {
        enabled = next;
        return Promise.resolve();
      });
    const prepareMcp = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn().mockResolvedValue({ id: asSessionId('session-connected') });
    const branchSession = vi.fn().mockResolvedValue({ id: asSessionId('session-disconnected') });
    const run = vi.fn<RunApplication>().mockImplementation(() =>
      Promise.resolve({
        session: { id: asSessionId('session-connected') },
        events: completion(),
      }),
    );
    const application = {
      models: { sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }) },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile()),
      prepareMcp,
      newSession,
      branchSession,
      run,
      listProfiles: vi.fn().mockResolvedValue([profile()]),
      listSessions: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockImplementation(() =>
        Promise.resolve([
          {
            serverId: 'docs',
            enabled,
            state: enabled ? ('ready' as const) : ('disconnected' as const),
          },
        ]),
      ),
      setMcpServerEnabled,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    });
    mounted.push(instance);

    await waitForInitialRender(stdout);
    stdin.push('/mcp connect docs');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'docs', true);
      expect(stdout.read()).toContain('Enabled MCP server docs; connection state: ready');
    });
    expect(newSession).not.toHaveBeenCalled();

    stdin.push('continue with docs');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalled();
    });
    expect(run.mock.calls[0]?.[0]).toBe('continue with docs');
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('sessionId');

    stdin.push('/mcp disconnect docs');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'docs', false);
      expect(stdout.read()).toContain('Disconnected MCP server docs');
    });
    expect(branchSession).toHaveBeenCalledWith(asSessionId('session-connected'), {
      profileId: 'default',
      skipDependencyPreparation: true,
    });
    expect(prepareMcp).toHaveBeenCalledTimes(3);
    expect(stderr.read()).toBe('');
  });

  it('tears down MCP first and clears a stale session when snapshot branching fails', async () => {
    let enabled = true;
    let releasePreparation: (() => void) | undefined;
    const pendingPreparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const setMcpServerEnabled = vi
      .fn()
      .mockImplementation((_profileId: string, _serverId: string, next: boolean) => {
        enabled = next;
        return Promise.resolve();
      });
    const prepareMcp = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => pendingPreparation);
    const branchSession = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const run = vi.fn<RunApplication>().mockImplementation(() =>
      Promise.resolve({
        session: { id: asSessionId('session-old') },
        events: completion(),
      }),
    );
    const application = {
      models: { sync: vi.fn().mockResolvedValue({ source: 'cache', fallback: false }) },
      mcp: undefined,
      approvalPrompts: undefined,
      initialize: vi.fn().mockResolvedValue(profile()),
      prepareMcp,
      branchSession,
      run,
      listProfiles: vi.fn().mockResolvedValue([profile()]),
      listSessions: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockImplementation(() =>
        Promise.resolve([
          {
            serverId: 'docs',
            enabled,
            state: enabled ? ('ready' as const) : ('disconnected' as const),
          },
        ]),
      ),
      setMcpServerEnabled,
    } as unknown as CliApplication;
    const stdin = inputStream();
    const stdout = outputStream();
    const stderr = outputStream();
    const instance = render(<TuiApp application={application} width={100} height={30} />, {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    });
    mounted.push(instance);

    await waitForInitialRender(stdout);
    stdin.push('start session');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    stdin.push('/mcp disconnect docs');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(prepareMcp).toHaveBeenCalledTimes(2);
    });
    stdin.push('must wait');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await instance.waitUntilRenderFlush();
    expect(run).toHaveBeenCalledTimes(1);
    releasePreparation?.();
    await vi.waitFor(() => {
      expect(branchSession).toHaveBeenCalledWith(asSessionId('session-old'), {
        profileId: 'default',
        skipDependencyPreparation: true,
      });
      expect(stdout.read()).toContain('model unavailable');
    });
    expect(setMcpServerEnabled).toHaveBeenCalledWith('default', 'docs', false);
    expect(prepareMcp).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 'must wait'.length; index += 1) {
      stdin.push('\u007f');
      await instance.waitUntilRenderFlush();
    }
    stdin.push('start safely');
    await instance.waitUntilRenderFlush();
    stdin.push('\r');
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    expect(run.mock.calls[1]?.[1]).not.toHaveProperty('sessionId');
    expect(stderr.read()).toBe('');
  });
});
