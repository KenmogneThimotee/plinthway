import { describe, expect, it } from 'vitest';

import type {
  ProfileCatalogGroup,
  ProfileModelCatalogSnapshot,
  ProviderCapability,
} from '@plinthway/app-core';

import {
  initialModelPickerState,
  reduceModelPicker,
  visibleModelRows,
} from '../../src/tui/model-picker.js';

const ready: ProviderCapability = { status: 'ready', authVariables: [] };

function catalog(
  entries: Readonly<Record<string, readonly string[]>>,
): ProfileModelCatalogSnapshot {
  const groups: ProfileCatalogGroup[] = Object.entries(entries).map(([providerId, modelIds]) => ({
    provider: { id: providerId, name: providerId.toUpperCase(), env: [] },
    execution: ready,
    models: modelIds.map((modelId) => ({
      id: `${providerId}/${modelId}`,
      providerId,
      modelId,
      name: modelId.toUpperCase(),
      capabilities: { toolCalls: true, reasoning: false, structuredOutput: false },
      execution: ready,
      current: false,
    })),
  }));
  return { groups, accountRefreshErrors: {}, cached: false };
}

describe('model picker state', () => {
  it('edits and clears the query while selecting only matching model references', () => {
    const models = catalog({ openai: ['gpt-4', 'gpt-5'], anthropic: ['claude'] });
    let state = initialModelPickerState(models);
    state = reduceModelPicker(state, { type: 'append', text: 'gpt' }, models, 4);
    expect(state).toMatchObject({ query: 'gpt', selectedRef: 'openai/gpt-4', pageStart: 0 });
    state = reduceModelPicker(state, { type: 'backspace' }, models, 4);
    expect(state.query).toBe('gp');
    state = reduceModelPicker(state, { type: 'clear' }, models, 4);
    expect(state.query).toBe('');
  });

  it('moves and pages through model references without selecting headings', () => {
    const models = catalog({ anthropic: ['a', 'b'], openai: ['c', 'd', 'e'] });
    let state = initialModelPickerState(models);
    state = reduceModelPicker(state, { type: 'move', delta: 1 }, models, 2);
    expect(state.selectedRef).toBe('anthropic/b');
    state = reduceModelPicker(state, { type: 'page', delta: 1 }, models, 2);
    expect(state).toMatchObject({ selectedRef: 'openai/d', pageStart: 2 });
  });

  it('has an explicit no-results selection state', () => {
    const models = catalog({ openai: ['gpt'] });
    const state = reduceModelPicker(
      initialModelPickerState(models),
      { type: 'append', text: 'missing' },
      models,
      4,
    );
    expect(state).toMatchObject({ query: 'missing', pageStart: 0 });
    expect(state.selectedRef).toBeUndefined();
  });

  it('preserves a selected reference across refresh and falls back to its nearest index', () => {
    const before = catalog({ openai: ['gpt-4', 'gpt-5', 'gpt-6'] });
    const preserved = reduceModelPicker(
      { query: 'gpt', selectedRef: 'openai/gpt-5', pageStart: 0 },
      { type: 'replace-catalog', catalog: before },
      before,
      8,
    );
    expect(preserved).toMatchObject({ query: 'gpt', selectedRef: 'openai/gpt-5' });

    const refreshed = catalog({ openai: ['gpt-4', 'gpt-6'] });
    const fallback = reduceModelPicker(
      preserved,
      { type: 'replace-catalog', catalog: refreshed },
      refreshed,
      8,
    );
    expect(fallback.selectedRef).toBe('openai/gpt-6');
  });

  it('bounds visible rows and includes headings needed by visible models', () => {
    const models = catalog({ anthropic: ['a', 'b', 'c'], openai: ['d', 'e', 'f'] });
    const visible = visibleModelRows({
      catalog: models,
      state: { query: '', selectedRef: 'anthropic/a', pageStart: 0 },
      height: 12,
      width: 80,
    });
    expect(visible.rows.length).toBeLessThanOrEqual(6);
    expect(visible.rows[0]).toMatchObject({ kind: 'provider', providerId: 'anthropic' });
    expect(visible.below).toBe(true);
  });
});
