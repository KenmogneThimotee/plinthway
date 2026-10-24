import { Text } from 'ink';

import type { ProfileCatalogModel, ProfileModelCatalogSnapshot } from '@plinthway/app-core';
import type { ModelMetadata } from '@plinthway/model-registry';

import { searchModelCatalog, visibleModelRows, type ModelPickerState } from '../model-picker.js';
import { OverlayFrame } from './frame.js';

const statusLabel = (status: string): string => status.replaceAll('-', ' ');

function CatalogModelsOverlay({
  catalog,
  pickerState,
  height,
  width,
  loading = false,
  error,
  detail,
}: {
  readonly catalog: ProfileModelCatalogSnapshot;
  readonly pickerState: ModelPickerState;
  readonly height: number;
  readonly width: number;
  readonly loading?: boolean;
  readonly error?: string | undefined;
  readonly detail?: ProfileCatalogModel | undefined;
}) {
  const result = searchModelCatalog(catalog, pickerState.query);
  const visible = visibleModelRows({
    catalog,
    state: pickerState,
    height: Math.max(1, height - 3),
    width,
  });
  return (
    <OverlayFrame title="Models">
      <Text>Search: {pickerState.query}</Text>
      <Text dimColor>
        {result.providerCount} providers · {result.modelCount} models
        {catalog.cached ? ' · cached' : ''}
      </Text>
      {loading && <Text color="yellow">Refreshing account models…</Text>}
      {detail !== undefined ? (
        <>
          <Text bold>
            {detail.name} · {detail.id}
          </Text>
          <Text color="yellow">adapter required</Text>
          {detail.execution.packageName !== undefined && (
            <Text>Package: {detail.execution.packageName}</Text>
          )}
          {detail.execution.authVariables.length > 0 && (
            <Text>Authentication: {detail.execution.authVariables.join(', ')}</Text>
          )}
          {detail.execution.endpoint !== undefined && (
            <Text>Endpoint: {detail.execution.endpoint}</Text>
          )}
          {detail.execution.documentation !== undefined && (
            <Text>Docs: {detail.execution.documentation}</Text>
          )}
          {detail.execution.reason !== undefined && <Text>{detail.execution.reason}</Text>}
        </>
      ) : result.modelCount === 0 ? (
        <Text>No models match “{pickerState.query}”</Text>
      ) : (
        <>
          {visible.above && <Text dimColor>↑ more above</Text>}
          {visible.rows.map((row) =>
            row.kind === 'provider' ? (
              <Text bold key={`provider:${row.providerId}`}>
                {row.label} ({row.modelCount}) · {statusLabel(row.status)}
              </Text>
            ) : (
              <Text key={row.model.id} {...(row.selected ? { color: 'cyan' as const } : {})}>
                {row.selected ? '›' : ' '} {row.label}
                {row.model.current ? ' · current' : ''}
              </Text>
            ),
          )}
          {visible.below && <Text dimColor>↓ more below</Text>}
        </>
      )}
      {Object.entries(catalog.accountRefreshErrors).map(([providerId, message]) => (
        <Text color="yellow" key={`refresh:${providerId}`}>
          {providerId}: {message}
        </Text>
      ))}
      {error !== undefined && <Text color="red">{error}</Text>}
      <Text dimColor>↑/↓ moves · PgUp/PgDn pages · Ctrl+U clears · Enter selects</Text>
    </OverlayFrame>
  );
}

type CatalogModelsOverlayProps = Parameters<typeof CatalogModelsOverlay>[0];

interface LegacyModelsOverlayProps {
  readonly models: readonly ModelMetadata[];
  readonly selected: number;
  readonly current?: string | undefined;
  readonly loading?: boolean;
  readonly error?: string | undefined;
}

export function ModelsOverlay(props: CatalogModelsOverlayProps | LegacyModelsOverlayProps) {
  if ('catalog' in props) return <CatalogModelsOverlay {...props} />;
  const execution = { status: 'ready' as const, authVariables: [] };
  const providerIds = [...new Set(props.models.map(({ providerId }) => providerId))];
  const catalog: ProfileModelCatalogSnapshot = {
    groups: providerIds.map((providerId) => ({
      provider: { id: providerId, name: providerId, env: [] },
      execution,
      models: props.models
        .filter((model) => model.providerId === providerId)
        .map((model) => ({
          ...model,
          execution,
          current: model.id === props.current,
        })),
    })),
    accountRefreshErrors: {},
    cached: false,
  };
  const selectedRef = props.models[props.selected]?.id;
  return (
    <CatalogModelsOverlay
      catalog={catalog}
      pickerState={{
        query: '',
        ...(selectedRef === undefined ? {} : { selectedRef }),
        pageStart: 0,
      }}
      height={20}
      width={100}
      {...(props.loading === undefined ? {} : { loading: props.loading })}
      {...(props.error === undefined ? {} : { error: props.error })}
    />
  );
}
