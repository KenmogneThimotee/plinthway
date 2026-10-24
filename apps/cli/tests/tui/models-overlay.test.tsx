import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import type {
  ProfileCatalogGroup,
  ProfileModelCatalogSnapshot,
  ProviderCapability,
} from '@plinthway/app-core';

import { initialModelPickerState } from '../../src/tui/model-picker.js';
import { ModelsOverlay } from '../../src/tui/overlays/models.js';

function capability(status: ProviderCapability['status']): ProviderCapability {
  return { status, authVariables: [] };
}

function group(
  providerId: string,
  status: ProviderCapability['status'],
  count: number,
): ProfileCatalogGroup {
  const execution = capability(status);
  return {
    provider: { id: providerId, name: providerId.toUpperCase(), env: [] },
    execution,
    models: Array.from({ length: count }, (_, index) => ({
      id: `${providerId}/model-${String(index)}`,
      providerId,
      modelId: `model-${String(index)}`,
      name:
        index === 0
          ? `${providerId.toUpperCase()} ${'very-long-'.repeat(10)}`
          : `Model ${String(index)}`,
      capabilities: { toolCalls: true, reasoning: false, structuredOutput: false },
      execution,
      current: providerId === 'ready' && index === 0,
    })),
  };
}

describe('ModelsOverlay', () => {
  it('renders query, counts, provider statuses, current state, and refresh errors', () => {
    const catalog: ProfileModelCatalogSnapshot = {
      groups: [
        group('ready', 'ready', 1),
        group('setup', 'setup-required', 1),
        group('adapter', 'adapter-required', 1),
      ],
      accountRefreshErrors: { chatgpt: 'Account model refresh failed: [REDACTED]' },
      cached: true,
    };
    const output = renderToString(
      <ModelsOverlay
        catalog={catalog}
        pickerState={initialModelPickerState(catalog)}
        height={20}
        width={80}
      />,
    );

    expect(output).toContain('Search:');
    expect(output).toContain('3 providers · 3 models · cached');
    expect(output).toContain('ready');
    expect(output).toContain('setup required');
    expect(output).toContain('adapter required');
    expect(output).toContain('current');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('…');
  });

  it('bounds rendered models and shows continuation and no-results states', () => {
    const catalog: ProfileModelCatalogSnapshot = {
      groups: [group('ready', 'ready', 7)],
      accountRefreshErrors: {},
      cached: false,
    };
    const output = renderToString(
      <ModelsOverlay
        catalog={catalog}
        pickerState={initialModelPickerState(catalog)}
        height={12}
        width={80}
      />,
    );
    expect(output).toContain('more below');
    expect(output).not.toContain('ready/model-6');
    expect(output.split('\n').length).toBeLessThanOrEqual(12);

    const empty = renderToString(
      <ModelsOverlay
        catalog={catalog}
        pickerState={{ query: 'missing', pageStart: 0 }}
        height={12}
        width={80}
      />,
    );
    expect(empty).toContain('No models match “missing”');
  });
});
