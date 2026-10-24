import { describe, expect, it } from 'vitest';

import type {
  JsonValue,
  ToolDescriptor,
  ToolInvocationOptions,
  ToolInvocationResult,
  ToolProvider,
} from '@plinthway/shared';

import { CompositeToolProvider } from './tool-provider.js';

class TestProvider implements ToolProvider {
  constructor(
    readonly tools: () => readonly ToolDescriptor[],
    readonly prefix: string,
  ) {}

  listTools(): readonly ToolDescriptor[] {
    return this.tools();
  }

  invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    return Promise.resolve({
      trusted: false,
      toolName,
      content: {
        provider: this.prefix,
        arguments: argumentsValue as JsonValue,
        timeoutMs: options.timeoutMs,
      },
      isError: false,
    });
  }
}

function descriptor(name: string, sourceId: string): ToolDescriptor {
  return {
    name,
    source: { kind: 'builtin', id: sourceId },
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
    intrinsicAction: 'allow',
  };
}

describe('CompositeToolProvider', () => {
  it('merges sorted catalogs and follows dynamic provider changes', () => {
    let dynamic = [descriptor('mcp.search', 'mcp')];
    const provider = new CompositeToolProvider([
      new TestProvider(() => [descriptor('shell.run', 'shell')], 'shell'),
      new TestProvider(() => dynamic, 'mcp'),
    ]);

    expect(provider.listTools().map((tool) => tool.name)).toEqual(['mcp.search', 'shell.run']);
    dynamic = [descriptor('mcp.fetch', 'mcp')];
    expect(provider.listTools().map((tool) => tool.name)).toEqual(['mcp.fetch', 'shell.run']);
  });

  it('rejects duplicate qualified tool names', () => {
    const provider = new CompositeToolProvider([
      new TestProvider(() => [descriptor('shell.run', 'first')], 'first'),
      new TestProvider(() => [descriptor('shell.run', 'second')], 'second'),
    ]);

    expect(() => provider.listTools()).toThrow(/duplicate tool shell\.run/i);
  });

  it('routes invocation through the provider that currently owns the tool', async () => {
    const provider = new CompositeToolProvider([
      new TestProvider(() => [descriptor('filesystem.stat', 'filesystem')], 'filesystem'),
      new TestProvider(() => [descriptor('shell.run', 'shell')], 'shell'),
    ]);

    await expect(
      provider.invoke('shell.run', { command: 'pwd' }, { timeoutMs: 100 }),
    ).resolves.toMatchObject({
      toolName: 'shell.run',
      content: { provider: 'shell', arguments: { command: 'pwd' } },
      isError: false,
    });
    await expect(provider.invoke('missing.run', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
  });
});
