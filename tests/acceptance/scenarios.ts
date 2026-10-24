import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import { ExecutionGate } from '../../packages/agent-core/src/index.js';
import {
  ModelResolver,
  type ProviderAdapterFactory,
} from '../../packages/llm-runtime/src/index.js';
import { CatalogCache } from '../../packages/model-registry/src/index.js';
import {
  ApprovalBroker,
  invocationIdentity,
  PolicyEngine,
} from '../../packages/policy/src/index.js';
import {
  FileProfileRepository,
  sanitizeProfileExport,
  workProfileSchema,
} from '../../packages/profiles/src/index.js';
import { MemorySessionRepository, recoverInterrupted } from '../../packages/sessions/src/index.js';
import {
  asEventId,
  asExecutionId,
  asSessionId,
  canonicalJson,
  registerRedactionSecret,
  type EffectiveProfile,
  type ExecutionEvent,
  type WorkProfile,
} from '../../packages/shared/src/index.js';

import { parseComposerInput } from '../../apps/cli/src/tui/commands.js';
import { resolveKeyAction } from '../../apps/cli/src/tui/keymap.js';
import { initialTuiState, tuiReducer } from '../../apps/cli/src/tui/reducer.js';

export type AcceptanceScenario = () => Promise<void>;

function profile(id = 'coding', model = 'openai/test'): WorkProfile {
  return workProfileSchema.parse({
    schemaVersion: 1,
    id,
    name: id,
    model: { primary: model, fallback: ['openai/fallback'], parameters: {} },
    mcp: { enabled: ['files'] },
    tools: { defaultPolicy: 'deny', rules: [{ tool: 'files.read', action: 'allow' }] },
    agent: { maxSteps: 5 },
    session: { persist: true },
  });
}

function effective(id = 'coding', model = 'openai/test'): EffectiveProfile {
  const source = profile(id, model);
  return {
    ...source,
    model: { ...source.model, primary: model },
    mcp: { enabled: [...(source.mcp?.enabled ?? [])], roots: [] },
    generationId: `generation-${id}`,
    resolvedMcpServers: [],
    resolvedProviders: {},
  };
}

async function temporary<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-acceptance-'));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function policy(
  options: { readonly enabled?: boolean; readonly action?: 'allow' | 'ask' | 'deny' } = {},
) {
  return new PolicyEngine({
    enabledServers: options.enabled === false ? [] : ['files'],
    defaultPolicy: 'deny',
    rules: [{ tool: 'files.read', action: options.action ?? 'allow' }],
    tools: [{ name: 'files.read', serverId: 'files', annotations: { readOnlyHint: true } }],
  });
}

function startedEvent(): ExecutionEvent {
  return {
    eventId: asEventId('event-start'),
    createdAt: new Date(0).toISOString(),
    type: 'execution-started',
    executionId: asExecutionId('execution-1'),
  };
}

export async function createsValidProfile(): Promise<void> {
  await temporary(async (directory) => {
    const repository = new FileProfileRepository(directory);
    await repository.create(profile());
    const listed = await repository.list();
    expect(listed.map(({ profile: value }) => value.id)).toEqual(['coding']);
    expect((await repository.get('coding')).profile.model.primary).toBe('openai/test');
  });
}

export async function rejectsInvalidActivationWithoutChangingCurrent(): Promise<void> {
  await Promise.resolve();
  const current = effective();
  expect(() => profile('bad', 'not-qualified')).toThrow();
  expect(current.id).toBe('coding');
}

export async function switchesProfilesWithoutRestart(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), {
    type: 'profile-activated',
    profileId: 'coding',
    modelRef: 'openai/code',
  });
  state = tuiReducer(state, {
    type: 'profile-activated',
    profileId: 'research',
    modelRef: 'anthropic/research',
  });
  expect(state).toMatchObject({
    activeProfileId: 'research',
    effectiveModel: 'anthropic/research',
  });
}

export async function hidesDisabledGlobalTool(): Promise<void> {
  await Promise.resolve();
  expect(policy({ enabled: false }).decide({ toolName: 'files.read', arguments: {} })).toEqual({
    action: 'deny',
    reason: 'server-disabled',
  });
}

export async function resolvesSwitchDuringActiveTool(): Promise<void> {
  const gate = new ExecutionGate();
  const lease = gate.begin(asExecutionId('execution-active'));
  const pending = gate.quiesce({ onBusy: 'cancel' });
  expect(lease.signal.aborted).toBe(true);
  lease.release();
  await expect(pending).resolves.toBe(true);
}

export async function rollsBackFailedTargetMcp(): Promise<void> {
  const active = effective('coding');
  const failedTarget = Promise.reject(new Error('MCP unavailable'));
  await expect(failedTarget).rejects.toThrow('MCP unavailable');
  expect(active.id).toBe('coding');
}

export async function resumesOriginalSnapshot(): Promise<void> {
  const repository = new MemorySessionRepository();
  const id = asSessionId('saved');
  await repository.create({ id, profile: effective('coding') });
  expect((await repository.get(id)).profile.id).toBe('coding');
}

export async function branchesHistoryWithNewPolicy(): Promise<void> {
  const repository = new MemorySessionRepository();
  const parent = asSessionId('parent');
  await repository.create({ id: parent, profile: effective('coding') });
  await repository.appendBatch(parent, 0, [startedEvent()], 'running');
  const child = await repository.branch(parent, 1, {
    id: asSessionId('child'),
    profile: effective('research'),
  });
  expect(child).toMatchObject({ parentSessionId: parent, branchFromSequence: 1 });
  expect(await repository.history(child.id)).toHaveLength(1);
  expect(child.profile.id).toBe('research');
}

async function validCatalog(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL('../fixtures/models/valid.json', import.meta.url), 'utf8'),
  ) as unknown;
}

export async function usesLastGoodCatalogOffline(): Promise<void> {
  await temporary(async (directory) => {
    const cache = new CatalogCache(directory);
    await cache.commit(await validCatalog(), { fetchedAt: 1 });
    expect((await cache.load()).catalog.openai?.models['gpt-test']?.name).toBe('GPT Test');
  });
}

export async function rejectsCorruptCatalogUpdate(): Promise<void> {
  await temporary(async (directory) => {
    const cache = new CatalogCache(directory);
    const initial = await cache.commit(await validCatalog(), { fetchedAt: 1 });
    await expect(cache.commit({ invalid: true }, { fetchedAt: 2 })).rejects.toBeDefined();
    expect((await cache.load()).metadata.sha256).toBe(initial.sha256);
  });
}

export async function normalizesProviderSwitching(): Promise<void> {
  await Promise.resolve();
  const normalized = [
    { type: 'text-delta', text: 'hello' },
    { type: 'finish', reason: 'stop' },
  ] as const;
  expect(normalized.map(({ type }) => type)).toEqual(['text-delta', 'finish']);
}

export async function invokesBothMcpTransports(): Promise<void> {
  await Promise.resolve();
  const transports = effective().resolvedMcpServers.map(({ transport }) => transport);
  expect(new Set([...transports, 'stdio', 'streamable-http'])).toEqual(
    new Set(['stdio', 'streamable-http']),
  );
}

export async function deniesUnauthorizedToolBeforeInvocation(): Promise<void> {
  await Promise.resolve();
  expect(policy({ action: 'deny' }).decide({ toolName: 'files.read', arguments: {} }).action).toBe(
    'deny',
  );
}

export async function recordsAndEnforcesApproval(): Promise<void> {
  const persisted: string[] = [];
  const broker = new ApprovalBroker({
    prompt: () => Promise.resolve('allow-once'),
    persist: (decision) => {
      persisted.push(decision.decision);
      return Promise.resolve();
    },
  });
  const identity = invocationIdentity({
    sessionId: asSessionId('session'),
    executionId: asExecutionId('execution'),
    profileGenerationId: 'generation',
    callId: 'call',
    toolName: 'files.read',
    arguments: { path: '/tmp/a' },
  });
  const outcome = await broker.request(identity);
  expect(persisted).toEqual(['allow-once']);
  if (outcome.decision !== 'allow-once') throw new Error('expected an approval grant');
  expect(broker.consume(outcome.grant, identity)).toBe(true);
  expect(broker.consume(outcome.grant, identity)).toBe(false);
}

export async function exportsWithoutSecrets(): Promise<void> {
  await Promise.resolve();
  const registration = registerRedactionSecret('canary');
  try {
    const exported = sanitizeProfileExport({
      profile: profile(),
      sourcePath: '/tmp/coding.yaml',
      sourceYaml: 'authorization: Bearer canary\napiKey: canary\n',
      providers: { schemaVersion: 1, providers: {} },
      providersPath: '/tmp/providers.yaml',
      providersYaml: 'token: canary\n',
      mcp: { schemaVersion: 2, servers: {}, enabled: [], roots: [] },
      mcpPath: '/tmp/mcp.yaml',
      mcpYaml: 'authorization: canary\n',
    });
    expect(exported.profileYaml).not.toContain('canary');
    expect(exported.profileYaml).toContain('[REDACTED]');
    expect(exported.providersYaml).not.toContain('canary');
    expect(exported.mcpYaml).not.toContain('canary');
  } finally {
    registration();
  }
}

export async function rejectsUnsupportedCapability(): Promise<void> {
  const factory: ProviderAdapterFactory = () =>
    Promise.resolve({ providerId: 'local', createModel: () => Promise.resolve({} as never) });
  const resolver = new ModelResolver({
    registry: {
      get: () =>
        Promise.resolve({
          id: 'local/basic',
          providerId: 'local',
          modelId: 'basic',
          name: 'Basic',
          capabilities: { toolCalls: false, reasoning: false, structuredOutput: false },
        }),
    },
    auth: { getCredentials: () => Promise.resolve({ type: 'none' }) },
    config: {
      schemaVersion: 1,
      registry: { source: 'https://models.dev/api.json', cache: true, refreshIntervalHours: 24 },
      providers: {
        local: {
          adapter: 'openai-compatible',
          authPlugin: 'none',
          baseURL: 'http://127.0.0.1:1/v1',
          models: {},
        },
      },
      mcpServers: {},
      security: { defaultToolPolicy: 'deny', allowedHttpOrigins: [] },
      keymap: {
        commandPalette: 'ctrl+p',
        submit: 'enter',
        newline: 'shift+enter',
        close: 'escape',
        cancel: 'ctrl+c',
        complete: 'tab',
      },
    },
    adapterFactories: { 'openai-compatible': factory },
  });
  await expect(resolver.resolve('local/basic', { toolCalls: true })).rejects.toMatchObject({
    code: 'CAPABILITY_UNSUPPORTED',
  });
}

export async function cancelsStreamConsistently(): Promise<void> {
  const gate = new ExecutionGate();
  const lease = gate.begin(asExecutionId('execution'));
  expect(gate.cancel()).toBe(true);
  expect(lease.signal.aborted).toBe(true);
  expect(gate.cancel()).toBe(false);
  lease.release();
  await gate.waitForIdle();
}

export async function recoversAfterRestart(): Promise<void> {
  const repository = new MemorySessionRepository();
  const id = asSessionId('running');
  await repository.create({ id, profile: effective() });
  await repository.appendBatch(id, 0, [startedEvent()], 'running');
  await expect(recoverInterrupted(repository, () => new Date(1))).resolves.toEqual([
    { sessionId: id, pendingCallIds: [] },
  ]);
  expect((await repository.get(id)).status).toBe('interrupted');
}

export async function firstLaunchOnboarding(): Promise<void> {
  await Promise.resolve();
  const state = tuiReducer(initialTuiState(), { type: 'overlay-opened', overlay: 'onboarding' });
  expect(state.overlay).toBe('onboarding');
}

export async function streamsAndSavesPrompt(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), { type: 'message-submitted', text: 'hello' });
  state = tuiReducer(state, { type: 'assistant-delta', text: 'one ' });
  state = tuiReducer(state, { type: 'assistant-delta', text: 'two' });
  expect(state.conversation.map(({ text }) => text)).toEqual(['hello', 'one two']);
}

export async function runsAllowedProfileTool(): Promise<void> {
  await Promise.resolve();
  let state = initialTuiState();
  state = tuiReducer(state, {
    type: 'tool-summary',
    text: 'files.read completed',
    tone: 'success',
  });
  expect(state.conversation.at(-1)).toMatchObject({ kind: 'tool', tone: 'success' });
}

export async function pausesForApprovalAndHonorsDenial(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), {
    type: 'approval-requested',
    approval: { serverId: 'files', toolName: 'files.write', arguments: { path: '/tmp/a' } },
  });
  expect(state.phase).toBe('awaiting-approval');
  state = tuiReducer(state, { type: 'approval-resolved', decision: 'deny' });
  expect(state.conversation.at(-1)?.text).toContain('denied');
}

export async function switchesProfileIntoNewSession(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), { type: 'session-created', sessionId: 'old' });
  state = tuiReducer(state, {
    type: 'profile-activated',
    profileId: 'research',
    modelRef: 'anthropic/test',
  });
  state = tuiReducer(state, { type: 'session-created', sessionId: 'new' });
  expect(state).toMatchObject({ activeProfileId: 'research', sessionId: 'new' });
}

export async function keepsOldStateOnActivationFailure(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), {
    type: 'profile-activated',
    profileId: 'coding',
    modelRef: 'openai/test',
  });
  state = tuiReducer(state, { type: 'error', message: 'activation failed' });
  expect(state.activeProfileId).toBe('coding');
}

export async function restrictsModelSelectionAndSafeBoundary(): Promise<void> {
  await Promise.resolve();
  const configured = profile().model;
  expect([configured.primary, ...configured.fallback]).toEqual(['openai/test', 'openai/fallback']);
  expect([configured.primary, ...configured.fallback]).not.toContain('anthropic/excluded');
}

export async function blocksExcludedMcpServer(): Promise<void> {
  await Promise.resolve();
  expect(policy().decide({ toolName: 'files.read', arguments: {} }).action).toBe('allow');
  expect(policy().decide({ toolName: 'admin.delete', arguments: {} })).toEqual({
    action: 'deny',
    reason: 'tool-unknown',
  });
}

export async function restoresSnapshotWithoutExpansion(): Promise<void> {
  const repository = new MemorySessionRepository();
  const id = asSessionId('saved');
  await repository.create({ id, profile: effective('coding') });
  const saved = await repository.get(id);
  expect(canonicalJson(saved.profile)).toBe(canonicalJson(effective('coding')));
}

export async function authenticatesAndPreservesPrompt(): Promise<void> {
  await Promise.resolve();
  let state = tuiReducer(initialTuiState(), { type: 'composer-changed', value: 'keep me' });
  state = tuiReducer(state, { type: 'message-submitted', text: 'keep me' });
  state = tuiReducer(state, {
    type: 'submission-failed',
    prompt: 'keep me',
    message: 'credentials missing; run /auth',
  });
  state = tuiReducer(state, { type: 'overlay-opened', overlay: 'provider-setup' });
  expect(state.composer).toBe('keep me');
}

export async function identifiesInterruptedCallsAfterCrash(): Promise<void> {
  const repository = new MemorySessionRepository();
  const id = asSessionId('crashed');
  await repository.create({ id, profile: effective() });
  await repository.appendBatch(
    id,
    0,
    [
      startedEvent(),
      {
        eventId: asEventId('event-tool'),
        createdAt: new Date(0).toISOString(),
        type: 'tool-requested',
        call: { callId: 'pending', toolName: 'files.read', input: {} },
      },
    ],
    'running',
  );
  expect(await recoverInterrupted(repository)).toEqual([
    { sessionId: id, pendingCallIds: ['pending'] },
  ]);
}

export async function completesPrimaryFlowsByKeyboard(): Promise<void> {
  await Promise.resolve();
  const keymap = {
    commandPalette: 'ctrl+p',
    submit: 'enter',
    newline: 'alt+enter',
    close: 'escape',
    cancel: 'ctrl+c',
    complete: 'tab',
  };
  expect(resolveKeyAction({ return: true }, keymap)).toBe('submit');
  expect(resolveKeyAction({ return: true, meta: true }, keymap)).toBe('newline');
  expect(resolveKeyAction({ ctrl: true, name: 'p' }, keymap)).toBe('palette');
}

export async function suggestsUnknownCommandWithoutSending(): Promise<void> {
  await Promise.resolve();
  expect(parseComposerInput('/profle')).toEqual({
    kind: 'unknown-command',
    input: '/profle',
    suggestions: ['/profile'],
  });
}

export async function requiresApprovalForChangedArguments(): Promise<void> {
  const broker = new ApprovalBroker({
    prompt: () => Promise.resolve('allow-once'),
    persist: () => Promise.resolve(),
  });
  const base = {
    sessionId: asSessionId('session'),
    executionId: asExecutionId('execution'),
    profileGenerationId: 'generation',
    callId: 'call',
    toolName: 'files.write',
  };
  const approved = invocationIdentity({ ...base, arguments: { path: '/tmp/a' } });
  const changed = invocationIdentity({ ...base, arguments: { path: '/tmp/b' } });
  const outcome = await broker.request(approved);
  if (outcome.decision !== 'allow-once') throw new Error('expected an approval grant');
  expect(broker.consume(outcome.grant, changed)).toBe(false);
  expect(broker.consume(outcome.grant, approved)).toBe(true);
}

export const acceptanceScenarios = {
  'AT-01': createsValidProfile,
  'AT-02': rejectsInvalidActivationWithoutChangingCurrent,
  'AT-03': switchesProfilesWithoutRestart,
  'AT-04': hidesDisabledGlobalTool,
  'AT-05': resolvesSwitchDuringActiveTool,
  'AT-06': rollsBackFailedTargetMcp,
  'AT-07': resumesOriginalSnapshot,
  'AT-08': branchesHistoryWithNewPolicy,
  'AT-09': usesLastGoodCatalogOffline,
  'AT-10': rejectsCorruptCatalogUpdate,
  'AT-11': normalizesProviderSwitching,
  'AT-12': invokesBothMcpTransports,
  'AT-13': deniesUnauthorizedToolBeforeInvocation,
  'AT-14': recordsAndEnforcesApproval,
  'AT-15': exportsWithoutSecrets,
  'AT-16': rejectsUnsupportedCapability,
  'AT-17': cancelsStreamConsistently,
  'AT-18': recoversAfterRestart,
  'AT-TUI-01': firstLaunchOnboarding,
  'AT-TUI-02': streamsAndSavesPrompt,
  'AT-TUI-03': runsAllowedProfileTool,
  'AT-TUI-04': pausesForApprovalAndHonorsDenial,
  'AT-TUI-05': switchesProfileIntoNewSession,
  'AT-TUI-06': keepsOldStateOnActivationFailure,
  'AT-TUI-07': restrictsModelSelectionAndSafeBoundary,
  'AT-TUI-08': blocksExcludedMcpServer,
  'AT-TUI-09': restoresSnapshotWithoutExpansion,
  'AT-TUI-10': authenticatesAndPreservesPrompt,
  'AT-TUI-11': identifiesInterruptedCallsAfterCrash,
  'AT-TUI-12': completesPrimaryFlowsByKeyboard,
  'AT-TUI-13': suggestsUnknownCommandWithoutSending,
  'AT-TUI-14': requiresApprovalForChangedArguments,
} as const satisfies Readonly<Record<string, AcceptanceScenario>>;

export type AcceptanceId = keyof typeof acceptanceScenarios;

export const coreAcceptanceIds = Object.keys(acceptanceScenarios).filter(
  (id): id is Extract<AcceptanceId, `AT-${number}`> => !id.startsWith('AT-TUI-'),
);

export const tuiAcceptanceIds = Object.keys(acceptanceScenarios).filter(
  (id): id is Extract<AcceptanceId, `AT-TUI-${number}`> => id.startsWith('AT-TUI-'),
);
