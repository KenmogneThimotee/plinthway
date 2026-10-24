import type {
  ProfileCatalogGroup,
  ProfileCatalogModel,
  ProfileModelCatalogSnapshot,
  ProviderExecutionStatus,
} from '@plinthway/app-core';

export interface ModelPickerState {
  readonly query: string;
  readonly selectedRef?: string;
  readonly pageStart: number;
}

export type ModelPickerAction =
  | { readonly type: 'append'; readonly text: string }
  | { readonly type: 'backspace' }
  | { readonly type: 'clear' }
  | { readonly type: 'move'; readonly delta: -1 | 1 }
  | { readonly type: 'page'; readonly delta: -1 | 1 }
  | { readonly type: 'replace-catalog'; readonly catalog: ProfileModelCatalogSnapshot };

export type ModelPickerRow =
  | {
      readonly kind: 'provider';
      readonly providerId: string;
      readonly label: string;
      readonly status: ProviderExecutionStatus;
      readonly modelCount: number;
    }
  | {
      readonly kind: 'model';
      readonly model: ProfileCatalogModel;
      readonly selected: boolean;
      readonly label: string;
    };

export interface ModelPickerSearchResult {
  readonly groups: readonly ProfileCatalogGroup[];
  readonly modelRefs: readonly string[];
  readonly providerCount: number;
  readonly modelCount: number;
}

const normalize = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('en-US').trim();

function matchClass(field: string, term: string): number | undefined {
  if (field === term) return 0;
  if (field.startsWith(term)) return 1;
  if (field.split(/[^\p{L}\p{N}]+/u).includes(term)) return 2;
  if (field.includes(term)) return 3;
  return undefined;
}

export function searchModelCatalog(
  catalog: ProfileModelCatalogSnapshot,
  rawQuery: string,
): ModelPickerSearchResult {
  const query = normalize(rawQuery);
  const terms = query.length === 0 ? [] : query.split(/\s+/u);
  const ranked = catalog.groups.flatMap((group) =>
    group.models.flatMap((model) => {
      const fields = [
        model.id,
        model.modelId,
        model.name,
        group.provider.id,
        group.provider.name,
      ].map(normalize);
      let worst = 0;
      let priority = 0;
      for (const term of terms) {
        const matches = fields
          .map((field, index) => [matchClass(field, term), index] as const)
          .filter((entry): entry is readonly [number, number] => entry[0] !== undefined)
          .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        const best = matches[0];
        if (best === undefined) return [];
        worst = Math.max(worst, best[0]);
        priority += best[1];
      }
      return [{ group, model, worst, priority }];
    }),
  );
  if (query.length > 0) {
    ranked.sort(
      (left, right) =>
        left.worst - right.worst ||
        left.priority - right.priority ||
        left.group.provider.name.localeCompare(right.group.provider.name) ||
        left.model.name.localeCompare(right.model.name) ||
        left.model.id.localeCompare(right.model.id),
    );
  }

  const grouped = new Map<string, { group: ProfileCatalogGroup; models: ProfileCatalogModel[] }>();
  for (const item of ranked) {
    const current = grouped.get(item.group.provider.id);
    if (current === undefined)
      grouped.set(item.group.provider.id, { group: item.group, models: [item.model] });
    else current.models.push(item.model);
  }
  const groups = [...grouped.values()].map(({ group, models }) => ({ ...group, models }));
  const modelRefs = groups.flatMap((group) => group.models.map(({ id }) => id));
  return {
    groups,
    modelRefs,
    providerCount: groups.length,
    modelCount: modelRefs.length,
  };
}

function selectionForQuery(
  state: ModelPickerState,
  catalog: ProfileModelCatalogSnapshot,
  query: string,
): ModelPickerState {
  const result = searchModelCatalog(catalog, query);
  const selectedRef =
    state.selectedRef !== undefined && result.modelRefs.includes(state.selectedRef)
      ? state.selectedRef
      : result.modelRefs[0];
  return { query, ...(selectedRef === undefined ? {} : { selectedRef }), pageStart: 0 };
}

export function initialModelPickerState(catalog: ProfileModelCatalogSnapshot): ModelPickerState {
  const result = searchModelCatalog(catalog, '');
  const current = result.groups.flatMap(({ models }) => models).find(({ current }) => current)?.id;
  const selectedRef = current ?? result.modelRefs[0];
  return { query: '', ...(selectedRef === undefined ? {} : { selectedRef }), pageStart: 0 };
}

export function reduceModelPicker(
  state: ModelPickerState,
  action: ModelPickerAction,
  catalog: ProfileModelCatalogSnapshot,
  pageSize: number,
): ModelPickerState {
  if (action.type === 'append')
    return selectionForQuery(state, catalog, `${state.query}${action.text}`);
  if (action.type === 'backspace')
    return selectionForQuery(state, catalog, state.query.slice(0, -1));
  if (action.type === 'clear') return selectionForQuery(state, catalog, '');

  const result = searchModelCatalog(catalog, state.query);
  if (result.modelRefs.length === 0) return { query: state.query, pageStart: 0 };
  const currentIndex = Math.max(0, result.modelRefs.indexOf(state.selectedRef ?? ''));
  if (action.type === 'move') {
    const next = Math.max(0, Math.min(result.modelRefs.length - 1, currentIndex + action.delta));
    const nextPageStart =
      next < state.pageStart
        ? next
        : next >= state.pageStart + pageSize
          ? next - pageSize + 1
          : state.pageStart;
    const selectedRef = result.modelRefs[next];
    if (selectedRef === undefined) return state;
    return { query: state.query, selectedRef, pageStart: nextPageStart };
  }
  if (action.type === 'page') {
    const next = Math.max(
      0,
      Math.min(result.modelRefs.length - 1, currentIndex + action.delta * pageSize),
    );
    const selectedRef = result.modelRefs[next];
    if (selectedRef === undefined) return state;
    return {
      query: state.query,
      selectedRef,
      pageStart: Math.max(
        0,
        Math.min(result.modelRefs.length - 1, state.pageStart + action.delta * pageSize),
      ),
    };
  }

  if (state.selectedRef !== undefined && result.modelRefs.includes(state.selectedRef)) return state;
  const fallback =
    state.selectedRef === undefined
      ? result.modelRefs[0]
      : (result.modelRefs.find((ref) => ref.localeCompare(state.selectedRef ?? '') > 0) ??
        result.modelRefs.at(-1));
  return {
    query: state.query,
    ...(fallback === undefined ? {} : { selectedRef: fallback }),
    pageStart: Math.min(state.pageStart, Math.max(0, result.modelRefs.length - 1)),
  };
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

export function visibleModelRows(input: {
  readonly catalog: ProfileModelCatalogSnapshot;
  readonly state: ModelPickerState;
  readonly height: number;
  readonly width: number;
}): { readonly rows: readonly ModelPickerRow[]; readonly above: boolean; readonly below: boolean } {
  const result = searchModelCatalog(input.catalog, input.state.query);
  const budget = Math.max(1, input.height - 6);
  const start = Math.max(
    0,
    Math.min(input.state.pageStart, Math.max(0, result.modelRefs.length - 1)),
  );
  const modelsByRef = new Map(
    result.groups.flatMap((group) =>
      group.models.map((model) => [model.id, { group, model }] as const),
    ),
  );
  const rows: ModelPickerRow[] = [];
  let consumed = 0;
  let previousProvider: string | undefined;
  for (const ref of result.modelRefs.slice(start)) {
    const entry = modelsByRef.get(ref);
    if (entry === undefined) continue;
    const newGroup = previousProvider !== entry.group.provider.id;
    const needed = newGroup && budget > 1 ? 2 : 1;
    if (rows.length + needed > budget) break;
    if (newGroup && budget > 1) {
      rows.push({
        kind: 'provider',
        providerId: entry.group.provider.id,
        label: truncate(
          `${entry.group.provider.name} · ${entry.group.provider.id}`,
          input.width - 4,
        ),
        status: entry.group.execution.status,
        modelCount: entry.group.models.length,
      });
    }
    rows.push({
      kind: 'model',
      model: entry.model,
      selected: entry.model.id === input.state.selectedRef,
      label: truncate(`${entry.model.name} · ${entry.model.id}`, input.width - 6),
    });
    previousProvider = entry.group.provider.id;
    consumed += 1;
  }
  return {
    rows,
    above: start > 0,
    below: start + consumed < result.modelRefs.length,
  };
}
