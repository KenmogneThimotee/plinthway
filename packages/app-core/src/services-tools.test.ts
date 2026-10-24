import { describe, expect, it, vi } from 'vitest';

import type { McpManager } from '@plinthway/mcp-client';
import type { LLMRuntime } from '@plinthway/llm-runtime';
import {
  asProfileId,
  PlinthwayError,
  type EffectiveProfile,
  type ToolProvider,
} from '@plinthway/shared';

import { ServiceDependencyPreparer } from './services.js';

const profile: EffectiveProfile = {
  schemaVersion: 1,
  id: asProfileId('default'),
  name: 'Default',
  model: { primary: 'openai/test', fallback: [], parameters: {} },
  mcp: { enabled: [], roots: [] },
  tools: { defaultPolicy: 'deny', rules: [] },
  agent: { maxSteps: 5 },
  session: { persist: true },
  resolvedMcpServers: [],
  resolvedProviders: {},
  generationId: 'generation-1',
};

describe('ServiceDependencyPreparer native tools', () => {
  it('requires tool-call support and exposes native tools in prepared dependencies', async () => {
    const resolve = vi.fn().mockResolvedValue({});
    const mcp = {
      prepare: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      listPreparedTools: vi.fn().mockReturnValue([]),
    } as unknown as McpManager;
    const nativeTools = {
      listTools: () => [
        {
          name: 'filesystem.read_text',
          source: { kind: 'builtin' as const, id: 'filesystem' },
          inputSchema: { type: 'object' },
          intrinsicAction: 'allow' as const,
        },
      ],
      invoke: vi.fn(),
    } satisfies ToolProvider;
    const preparer = new ServiceDependencyPreparer({
      llm: { resolve } as unknown as LLMRuntime,
      mcp,
      nativeTools,
    });

    const prepared = await preparer.prepare(profile);

    expect(resolve).toHaveBeenCalledWith(
      'openai/test',
      { toolCalls: true },
      expect.objectContaining({ profileId: 'default' }),
    );
    expect(prepared.tools).toEqual([
      expect.objectContaining({
        name: 'filesystem.read_text',
        source: { kind: 'builtin', id: 'filesystem' },
      }),
    ]);
  });

  it('rejects a selected model without tool-call support before preparing MCP', async () => {
    const prepare = vi.fn();
    const preparer = new ServiceDependencyPreparer({
      llm: {
        resolve: vi
          .fn()
          .mockRejectedValue(new PlinthwayError('CAPABILITY_UNSUPPORTED', 'Tools unsupported')),
      } as unknown as LLMRuntime,
      mcp: { prepare, rollback: vi.fn() } as unknown as McpManager,
      nativeTools: { listTools: () => [], invoke: vi.fn() },
    });

    await expect(preparer.prepare(profile)).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
