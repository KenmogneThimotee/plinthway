import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';

import {
  asSessionId,
  PlinthwayError,
  redact,
  type ToolDescriptor,
  type WorkProfile,
} from '@plinthway/shared';
import type {
  McpHostEvent,
  McpInteractionRequest,
  McpPersistedTask,
  McpPrompt,
  McpResource,
  McpSkill,
  McpActiveSkill,
  McpAppDescriptor,
  AppSession,
} from '@plinthway/mcp-client';
import type { StoredSession } from '@plinthway/sessions';
import type { ApprovalResponse } from '@plinthway/policy';
import type {
  ConfiguredMcpServerStatus,
  ProfileCatalogModel,
  ProfileModelCatalogSnapshot,
} from '@plinthway/app-core';

import type { CliApplication } from '../application.js';
import {
  CommandHelper,
  commandSuggestions,
  parseComposerInput,
  type SlashCommand,
} from './commands.js';
import { Composer } from './components/composer.js';
import { Conversation, type ConversationScrollRequest } from './components/conversation.js';
import { Header } from './components/header.js';
import { Status } from './components/status.js';
import { defaultKeymap, resolveKeyAction, type TuiKeymap } from './keymap.js';
import { ApprovalOverlay } from './overlays/approval.js';
import { ChatGptAuthOverlay } from './overlays/chatgpt-auth.js';
import { OverlayFrame } from './overlays/frame.js';
import {
  McpOverlay,
  mcpInteractionNeedsResponse,
  mcpServerNeedsConnection,
} from './overlays/mcp.js';
import { ModelsOverlay } from './overlays/models.js';
import {
  ProviderSetupOverlay,
  type ProviderConfiguration,
  type ProviderSetupPrefill,
} from './overlays/provider-setup.js';
import {
  initialModelPickerState,
  reduceModelPicker,
  type ModelPickerState,
} from './model-picker.js';
import { ProfilesOverlay } from './overlays/profiles.js';
import { SessionsOverlay } from './overlays/sessions.js';
import { effectiveToolPolicy, ToolsOverlay } from './overlays/tools.js';
import { initialTuiState, tuiReducer } from './reducer.js';
import { initialStartupState, startupReducer } from './startup.js';
import { useMouseWheel } from './use-mouse-wheel.js';

export interface TuiAppProps {
  readonly application: CliApplication;
  readonly keymap?: TuiKeymap | undefined;
  readonly width?: number;
  readonly height?: number;
}

const EMPTY_MODEL_CATALOG: ProfileModelCatalogSnapshot = Object.freeze({
  groups: Object.freeze([]),
  accountRefreshErrors: Object.freeze({}),
  cached: false,
});

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The operation failed';
  return String(redact(message));
}

const refIsTrue = (ref: { readonly current: boolean }): boolean => ref.current;

export function actionableMessage(error: unknown, profileId?: string): string {
  if (error instanceof PlinthwayError) {
    if (error.details.providerError === 'server_is_overloaded') {
      return 'ChatGPT is temporarily overloaded. Your prompt has been restored; retry shortly.';
    }
    if (error.code === 'MODEL_NOT_CONFIGURED' || error.code === 'PROVIDER_NOT_CONFIGURED') {
      return `Profile ${profileId ?? 'default'} is not ready. Run /provider to configure a provider and model; your prompt has been restored.`;
    }
    if (error.code === 'CREDENTIAL_MISSING') {
      return 'This provider needs an API key. Run /auth to configure it; your prompt has been restored.';
    }
    if (error.code === 'KEYRING_UNAVAILABLE') {
      return 'The OS keyring is unavailable, so the API key cannot be stored safely. Fix keyring access and run /auth; your prompt has been restored.';
    }
  }
  return `${safeMessage(error)} Your prompt has been restored; use /provider, /model, or /auth to adjust the configuration.`;
}

function mcpHealth(
  statuses: readonly ConfiguredMcpServerStatus[],
): 'disconnected' | 'healthy' | 'degraded' {
  const enabled = statuses.filter((status) => status.enabled);
  if (enabled.length === 0) return 'disconnected';
  return enabled.every((status) => status.state === 'ready') ? 'healthy' : 'degraded';
}

export function isNarrowTerminal(width: number): boolean {
  return width < 88;
}

function bodyHeight(terminalHeight: number, helperHeight = 0): number {
  return Math.max(3, terminalHeight - 7 - helperHeight);
}

function modelPageSize(terminalHeight: number): number {
  return Math.max(1, bodyHeight(terminalHeight) - 9);
}

function HelpOverlay() {
  return (
    <OverlayFrame title="Commands">
      <Text>/profile [new|id] · /provider · /model · /mcp · /tools · /sessions</Text>
      <Text>/new · /auth · /status · /help · //literal slash</Text>
    </OverlayFrame>
  );
}

export function TuiApp({
  application,
  keymap = defaultKeymap,
  width = 80,
  height = 24,
}: TuiAppProps) {
  const [state, dispatch] = useReducer(tuiReducer, { width, height }, initialTuiState);
  const [startup, dispatchStartup] = useReducer(startupReducer, undefined, initialStartupState);
  const [profiles, setProfiles] = useState<readonly WorkProfile[]>([]);
  const [sessions, setSessions] = useState<readonly StoredSession[]>([]);
  const [commandSelection, setCommandSelection] = useState(0);
  const [commandHelperDismissed, setCommandHelperDismissed] = useState(false);
  const [scrollRequest, setScrollRequest] = useState<ConversationScrollRequest>();
  const [statuses, setStatuses] = useState<readonly ConfiguredMcpServerStatus[]>([]);
  const [tools, setTools] = useState<readonly ToolDescriptor[]>([]);
  const [prompts, setPrompts] = useState<readonly McpPrompt[]>([]);
  const [resources, setResources] = useState<readonly McpResource[]>([]);
  const [skills, setSkills] = useState<readonly McpSkill[]>([]);
  const [activeSkills, setActiveSkills] = useState<readonly McpActiveSkill[]>([]);
  const [apps, setApps] = useState<readonly McpAppDescriptor[]>([]);
  const [appSessions, setAppSessions] = useState<readonly AppSession[]>([]);
  const [mcpEvents, setMcpEvents] = useState<readonly McpHostEvent[]>([]);
  const [interactions, setInteractions] = useState<readonly McpInteractionRequest[]>([]);
  const [mcpTasks, setMcpTasks] = useState<readonly McpPersistedTask[]>([]);
  const [interactionResponse, setInteractionResponse] = useState('');
  const [selected, setSelected] = useState(0);
  const [selectedMcpServer, setSelectedMcpServer] = useState(0);
  const [modelCatalog, setModelCatalog] =
    useState<ProfileModelCatalogSnapshot>(EMPTY_MODEL_CATALOG);
  const [modelPicker, setModelPicker] = useState<ModelPickerState>({ query: '', pageStart: 0 });
  const [modelSetupPrefill, setModelSetupPrefill] = useState<ProviderSetupPrefill>();
  const [modelDetail, setModelDetail] = useState<ProfileCatalogModel>();
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | undefined>();
  const activeProfile = profiles.find((profile) => profile.id === state.activeProfileId);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastInterruptRef = useRef(0);
  const mountedRef = useRef(true);
  const approvalResolveRef = useRef<((decision: ApprovalResponse) => void) | undefined>(undefined);
  const { exit } = useApp();
  const { stdout } = useStdout();

  useMouseWheel(
    (direction) => {
      setScrollRequest((current) => ({
        id: (current?.id ?? 0) + 1,
        action: direction === 'up' ? 'page-up' : 'page-down',
      }));
    },
    startup.phase === 'ready' && state.overlay === undefined,
  );

  useEffect(() => {
    const resized = (): void => {
      const terminal = stdout as NodeJS.WritableStream & {
        readonly columns?: number;
        readonly rows?: number;
      };
      dispatch({
        type: 'resized',
        width: terminal.columns ?? width,
        height: terminal.rows ?? height,
      });
    };
    stdout.on('resize', resized);
    return () => {
      stdout.off('resize', resized);
    };
  }, [height, stdout, width]);

  const refresh = useCallback(async () => {
    const nextProfiles = await application.listProfiles();
    const nextSessions = await application.listSessions();
    const nextMcpTasks = application.mcp === undefined ? [] : await application.mcp.listTasks();
    const nextStatuses = await application.listMcpServers();
    if (!mountedRef.current) return;
    setProfiles(nextProfiles);
    setSessions(nextSessions);
    setStatuses(nextStatuses);
    const listTools = (application as Partial<Pick<CliApplication, 'listTools'>>).listTools;
    setTools(listTools?.call(application) ?? []);
    setPrompts(application.mcp?.listPrompts() ?? []);
    setResources(application.mcp?.listResources() ?? []);
    setSkills(application.mcp?.listSkills() ?? []);
    setActiveSkills(application.mcp?.listActiveSkills() ?? []);
    setApps(application.mcp?.listApps() ?? []);
    setAppSessions(application.mcp?.listAppSessions() ?? []);
    setMcpEvents(application.mcp?.listEvents() ?? []);
    setInteractions(application.mcp?.interactions.pending() ?? []);
    setMcpTasks(nextMcpTasks);
    dispatch({ type: 'mcp-health', health: mcpHealth(nextStatuses) });
  }, [application]);

  useEffect(() => {
    const unsubscribeInteraction = application.mcp?.interactions.onRequest(() => {
      setInteractions(application.mcp?.interactions.pending() ?? []);
    });
    const unsubscribeEvent = application.mcp?.onEvent(() => {
      setMcpEvents(application.mcp?.listEvents() ?? []);
    });
    return () => {
      unsubscribeInteraction?.();
      unsubscribeEvent?.();
    };
  }, [application]);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const sync = await application.models?.sync();
        if (!mountedRef.current) return;
        dispatchStartup({
          type: 'succeeded',
          source: sync?.source ?? 'network',
          fallback: sync?.fallback ?? false,
        });
        const profile = await application.initialize();
        if (profile !== undefined) await application.prepareMcp(profile.id);
        await refresh();
        if (sync?.fallback === true) {
          dispatch({
            type: 'system-message',
            text: 'Network unavailable; using the cached model catalog.',
            tone: 'warning',
          });
        }
        if (profile !== undefined) {
          dispatch({
            type: 'profile-activated',
            profileId: profile.id,
            modelRef: profile.model.primary,
          });
          if (profile.model.primary === undefined) {
            dispatch({ type: 'overlay-opened', overlay: 'provider-setup' });
          }
        }
      } catch (error) {
        if (mountedRef.current) dispatchStartup({ type: 'failed', message: safeMessage(error) });
      }
    })();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [application, refresh, startup.attempt]);

  useEffect(() => {
    return application.approvalPrompts?.attach({
      prompt: (request) => {
        dispatch({
          type: 'approval-requested',
          approval: {
            serverId: request.serverId,
            toolName: request.toolName,
            arguments: request.arguments,
            targets: request.targets,
            readOnlyHint: request.readOnlyHint,
            sideEffects: request.sideEffects,
          },
        });
        return new Promise<ApprovalResponse>((resolve) => {
          approvalResolveRef.current = resolve;
        });
      },
      persisted: (decision) => {
        dispatch({ type: 'approval-resolved', decision: decision.decision });
        if (decision.decision === 'allow-once') {
          dispatch({
            type: 'tool-summary',
            text: 'Approval persisted; executing tool',
            tone: 'success',
          });
        }
      },
    });
  }, [application]);

  const open = useCallback(
    async (
      overlay: 'profiles' | 'models' | 'mcp' | 'tools' | 'sessions' | 'help' | 'provider-setup',
    ) => {
      try {
        await refresh();
        setSelected(0);
        setSelectedMcpServer(0);
        setInteractionResponse('');
        dispatch({ type: 'overlay-opened', overlay });
      } catch (error) {
        dispatch({ type: 'error', message: safeMessage(error) });
      }
    },
    [refresh],
  );

  const startNewSession = useCallback(
    async (profileId?: string) => {
      try {
        const session = await application.newSession(profileId === undefined ? {} : { profileId });
        dispatch({ type: 'session-created', sessionId: session.id });
        setSessions(await application.listSessions());
        return session;
      } catch (error) {
        dispatch({ type: 'error', message: safeMessage(error) });
        return undefined;
      }
    },
    [application],
  );

  const activateProfile = useCallback(
    async (profile: WorkProfile) => {
      try {
        const activated = await application.switchProfile(profile.id, { onBusy: 'cancel' });
        dispatch({
          type: 'profile-activated',
          profileId: activated.id,
          modelRef: activated.model.primary,
        });
        dispatch({ type: 'overlay-closed' });
        if (activated.model.primary !== undefined) await startNewSession(activated.id);
        await refresh();
      } catch (error) {
        dispatch({ type: 'error', message: safeMessage(error) });
      }
    },
    [application, refresh, startNewSession],
  );

  const consumeRun = useCallback(
    async (text: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'message-submitted', text });
      try {
        const run = await application.run(text, {
          ...(state.sessionId === undefined ? {} : { sessionId: asSessionId(state.sessionId) }),
          signal: controller.signal,
        });
        dispatch({ type: 'session-created', sessionId: run.session.id });
        for await (const event of run.events) {
          if (event.type === 'text-delta') dispatch({ type: 'assistant-delta', text: event.text });
          else if (event.type === 'reasoning-delta')
            dispatch({ type: 'tool-summary', text: event.text });
          else if (event.type === 'tool-call')
            dispatch({ type: 'tool-summary', text: `requested ${event.toolName}` });
          else if (event.type === 'usage')
            dispatch({
              type: 'tool-summary',
              text: `usage ${String(event.inputTokens)} in / ${String(event.outputTokens)} out`,
            });
          else if (event.reason === 'cancelled') dispatch({ type: 'run-cancelled' });
        }
        if (!controller.signal.aborted) dispatch({ type: 'run-finished' });
        await refresh();
      } catch (error) {
        dispatch(
          controller.signal.aborted
            ? { type: 'run-cancelled' }
            : {
                type: 'submission-failed',
                prompt: text,
                message: actionableMessage(error, state.activeProfileId),
              },
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
      }
    },
    [application, refresh, state.sessionId],
  );

  const openModels = useCallback(async () => {
    const profileId = state.activeProfileId;
    if (profileId === undefined) {
      await open('provider-setup');
      return;
    }
    setModelCatalog(EMPTY_MODEL_CATALOG);
    setModelPicker({ query: '', pageStart: 0 });
    setModelSetupPrefill(undefined);
    setModelDetail(undefined);
    setModelError(undefined);
    setModelLoading(true);
    dispatch({ type: 'overlay-opened', overlay: 'models' });
    try {
      const catalog = await application.getModelCatalog(profileId);
      if (!refIsTrue(mountedRef)) return;
      setModelCatalog(catalog);
      setModelPicker(initialModelPickerState(catalog));
      const refreshed = await application.refreshModelCatalogAccounts(profileId);
      if (!mountedRef.current) return;
      setModelCatalog(refreshed);
      setModelPicker((current) =>
        reduceModelPicker(
          current,
          { type: 'replace-catalog', catalog: refreshed },
          refreshed,
          modelPageSize(state.terminal.height),
        ),
      );
    } catch (error) {
      if (mountedRef.current) setModelError(safeMessage(error));
    } finally {
      if (mountedRef.current) setModelLoading(false);
    }
  }, [application, open, state.activeProfileId, state.terminal.height]);

  const updateMcpConnection = useCallback(
    async (serverId: string, enabled: boolean) => {
      dispatch({ type: 'mcp-update-started' });
      let selectionChanged = false;
      try {
        const profileId = state.activeProfileId;
        if (profileId === undefined) {
          throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
        }
        await application.setMcpServerEnabled(profileId, serverId, enabled);
        selectionChanged = true;
        await application.prepareMcp(profileId);
        let status = (await application.listMcpServers(profileId)).find(
          (entry) => entry.serverId === serverId,
        );
        if (enabled && status?.state === 'auth-required' && application.mcp !== undefined) {
          const authorization = await application.mcp.authorize(serverId);
          await authorization.waitForCompletion?.();
          status = (await application.listMcpServers(profileId)).find(
            (entry) => entry.serverId === serverId,
          );
        }
        if (state.sessionId !== undefined) {
          const session = await application.branchSession(asSessionId(state.sessionId), {
            profileId,
            skipDependencyPreparation: true,
          });
          dispatch({ type: 'session-created', sessionId: session.id });
        }
        await refresh();
        status = (await application.listMcpServers(profileId)).find(
          (entry) => entry.serverId === serverId,
        );
        dispatch({
          type: 'system-message',
          text: enabled
            ? `Enabled MCP server ${serverId}; connection state: ${status?.state ?? 'disconnected'}`
            : `Disconnected MCP server ${serverId}`,
          tone: 'success',
        });
        dispatch({ type: 'mcp-update-finished' });
      } catch (error) {
        if (selectionChanged) dispatch({ type: 'session-cleared' });
        dispatch({ type: 'error', message: safeMessage(error) });
      }
    },
    [application, refresh, state.activeProfileId, state.sessionId],
  );

  const runCommand = useCallback(
    async (name: SlashCommand, args: readonly string[]) => {
      if (name === 'profile') {
        if (args[0] === 'new') {
          setModelSetupPrefill(undefined);
          await open('provider-setup');
        } else if (args[0] !== undefined) {
          const profile = profiles.find((candidate) => candidate.id === args[0]);
          if (profile === undefined)
            dispatch({ type: 'error', message: `Profile ${args[0]} was not found` });
          else await activateProfile(profile);
        } else await open('profiles');
      } else if (name === 'provider' || name === 'auth') {
        setModelSetupPrefill(undefined);
        await open('provider-setup');
      } else if (name === 'model') {
        await openModels();
      } else if (name === 'mcp') {
        if ((args[0] === 'connect' || args[0] === 'disconnect') && args[1] !== undefined) {
          await updateMcpConnection(args[1], args[0] === 'connect');
        } else if (args[0] === 'open' && args[1] !== undefined) {
          try {
            const auditSessionId = (await application.newSession()).id;
            const appSession = await application.mcp?.openApp(args[1], { auditSessionId });
            if (appSession !== undefined) {
              setAppSessions(application.mcp?.listAppSessions() ?? []);
              dispatch({
                type: 'system-message',
                text: `MCP App ${args[1]}: ${appSession.url}`,
                tone: 'success',
              });
            }
          } catch (error) {
            dispatch({ type: 'error', message: safeMessage(error) });
          }
        } else if (args[0] === 'close' && args[1] !== undefined) {
          try {
            await application.mcp?.closeApp(args[1]);
            setAppSessions(application.mcp?.listAppSessions() ?? []);
            dispatch({
              type: 'system-message',
              text: `Closed MCP App ${args[1]}`,
              tone: 'success',
            });
          } catch (error) {
            dispatch({ type: 'error', message: safeMessage(error) });
          }
        } else await open('mcp');
      } else if (name === 'tools') await open('tools');
      else if (name === 'sessions') await open('sessions');
      else if (name === 'help') await open('help');
      else if (name === 'new') {
        await startNewSession(state.activeProfileId);
        dispatch({ type: 'system-message', text: 'Started a new session', tone: 'success' });
      } else {
        dispatch({
          type: 'system-message',
          text: `profile ${state.activeProfileId ?? 'none'} · model ${state.effectiveModel ?? 'none'} · mcp ${state.mcpHealth}`,
        });
      }
    },
    [
      activateProfile,
      application,
      open,
      openModels,
      profiles,
      refresh,
      startNewSession,
      state.activeProfileId,
      state.effectiveModel,
      state.mcpHealth,
      state.sessionId,
      updateMcpConnection,
    ],
  );

  const submit = useCallback(
    (value: string = state.composer) => {
      if (
        value.trim().length === 0 ||
        state.phase === 'running' ||
        state.phase === 'updating-mcp' ||
        state.phase === 'awaiting-approval'
      )
        return;
      const parsed = parseComposerInput(value);
      if (parsed.kind === 'message') void consumeRun(parsed.text);
      else if (parsed.kind === 'command') {
        dispatch({ type: 'composer-changed', value: '' });
        void runCommand(parsed.name, parsed.args);
      } else {
        dispatch({
          type: 'system-message',
          text:
            parsed.suggestions.length === 0
              ? `Unknown command ${parsed.input}`
              : `Unknown command ${parsed.input}. Did you mean ${parsed.suggestions.join(', ')}?`,
          tone: 'warning',
        });
      }
    },
    [consumeRun, runCommand, state.composer, state.phase],
  );

  const slashSuggestions = useMemo(
    () => (commandHelperDismissed ? [] : commandSuggestions(state.composer)),
    [commandHelperDismissed, state.composer],
  );
  const slashHelperVisible =
    state.overlay === undefined &&
    state.phase !== 'running' &&
    state.phase !== 'updating-mcp' &&
    state.phase !== 'awaiting-approval' &&
    slashSuggestions.length > 0;

  useEffect(() => {
    setCommandSelection(0);
    setCommandHelperDismissed(false);
  }, [state.composer]);

  useInput((input, key) => {
    if (startup.phase !== 'ready') {
      if (startup.phase === 'blocked' && input.toLowerCase() === 'r') {
        dispatchStartup({ type: 'retry' });
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        exit();
      }
      return;
    }
    const action = resolveKeyAction(
      {
        ...(input.length === 0 ? {} : { name: input }),
        return: key.return,
        escape: key.escape,
        tab: key.tab,
        ctrl: key.ctrl,
        shift: key.shift,
        meta: key.meta,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        end: key.end,
      },
      keymap,
    );
    if (state.overlay !== undefined) {
      if (state.overlay === 'models') {
        const pageSize = modelPageSize(state.terminal.height);
        const updatePicker = (pickerAction: Parameters<typeof reduceModelPicker>[1]): void => {
          setModelDetail(undefined);
          setModelPicker((current) =>
            reduceModelPicker(current, pickerAction, modelCatalog, pageSize),
          );
        };
        if (action === 'close') {
          setModelDetail(undefined);
          dispatch({ type: 'overlay-closed' });
        } else if (key.ctrl && input.toLowerCase() === 'u') {
          updatePicker({ type: 'clear' });
        } else if (key.backspace || key.delete) {
          updatePicker({ type: 'backspace' });
        } else if (key.upArrow || key.downArrow) {
          updatePicker({ type: 'move', delta: key.downArrow ? 1 : -1 });
        } else if (key.pageUp || key.pageDown) {
          updatePicker({ type: 'page', delta: key.pageDown ? 1 : -1 });
        } else if (action === 'submit') {
          const model = modelCatalog.groups
            .flatMap(({ models }) => models)
            .find(({ id }) => id === modelPicker.selectedRef);
          const profileId = state.activeProfileId;
          if (model !== undefined && profileId !== undefined) {
            if (model.execution.status === 'adapter-required') {
              setModelDetail(model);
            } else if (model.execution.status === 'setup-required') {
              if (model.providerId === 'chatgpt') {
                dispatch({ type: 'overlay-opened', overlay: 'chatgpt-auth' });
              } else if (model.execution.setup === undefined) {
                setModelError('This provider does not expose a safe setup path.');
              } else {
                setModelSetupPrefill({ ...model.execution.setup, model });
                dispatch({ type: 'overlay-opened', overlay: 'provider-setup' });
              }
            } else {
              void (async () => {
                try {
                  const session = await application.activateModelSelection({
                    profileId,
                    modelRef: model.id,
                  });
                  dispatch({ type: 'session-created', sessionId: session.id });
                  dispatch({ type: 'profile-activated', profileId, modelRef: model.id });
                  dispatch({ type: 'overlay-closed' });
                  dispatch({
                    type: 'system-message',
                    text: `Profile ${profileId} now uses ${model.id}`,
                    tone: 'success',
                  });
                  await refresh();
                } catch (error) {
                  setModelError(safeMessage(error));
                }
              })();
            }
          }
        } else if (!key.ctrl && !key.meta && input.length > 0) {
          updatePicker({ type: 'append', text: input });
        }
      } else if (
        state.overlay === 'approval' &&
        state.approval?.submitting !== true &&
        (input.toLowerCase() === 'a' || input.toLowerCase() === 'd')
      ) {
        dispatch({ type: 'approval-submitting' });
        approvalResolveRef.current?.(input.toLowerCase() === 'a' ? 'allow-once' : 'deny');
        approvalResolveRef.current = undefined;
      } else if (
        action === 'close' &&
        state.overlay === 'approval' &&
        state.approval?.submitting !== true
      ) {
        dispatch({ type: 'approval-submitting' });
        approvalResolveRef.current?.('deny');
        approvalResolveRef.current = undefined;
      } else if (state.overlay === 'mcp') {
        const interaction = interactions[selected];
        const decision = input.toLowerCase();
        const broker = application.mcp?.interactions;
        if (action === 'close') {
          dispatch({ type: 'overlay-closed' });
        } else if (interaction !== undefined && (key.upArrow || key.downArrow)) {
          setSelected(
            (current) =>
              (current + (key.downArrow ? 1 : -1) + interactions.length) % interactions.length,
          );
          setInteractionResponse('');
        } else if (interaction !== undefined && decision === 'd') {
          broker?.decline(interaction.id);
          setInteractions(broker?.pending() ?? []);
          setInteractionResponse('');
          setSelected(0);
        } else if (interaction !== undefined && decision === 'x') {
          broker?.cancel(interaction.id);
          setInteractions(broker?.pending() ?? []);
          setInteractionResponse('');
          setSelected(0);
        } else if (
          interaction !== undefined &&
          decision === 'a' &&
          !mcpInteractionNeedsResponse(interaction)
        ) {
          if (interaction.method === 'elicitation/create') {
            broker?.approve(interaction.id, { action: 'accept' });
          } else {
            broker?.approve(interaction.id);
          }
          setInteractions(broker?.pending() ?? []);
          setInteractionResponse('');
          setSelected(0);
        } else if (
          interaction !== undefined &&
          action === 'submit' &&
          mcpInteractionNeedsResponse(interaction)
        ) {
          try {
            const response = JSON.parse(interactionResponse) as unknown;
            broker?.approve(
              interaction.id,
              interaction.method === 'elicitation/create'
                ? { action: 'accept', content: response }
                : response,
            );
            setInteractions(broker?.pending() ?? []);
            setInteractionResponse('');
            setSelected(0);
          } catch (error) {
            dispatch({
              type: 'error',
              message: `Interaction response must be valid JSON: ${safeMessage(error)}`,
            });
          }
        } else if (interaction !== undefined && (key.backspace || key.delete)) {
          setInteractionResponse((current) => current.slice(0, -1));
        } else if (
          interaction !== undefined &&
          !key.ctrl &&
          !key.meta &&
          input.length > 0 &&
          decision !== 'a'
        ) {
          setInteractionResponse((current) => `${current}${input}`);
        } else if (
          interactions.length === 0 &&
          statuses.length > 0 &&
          (key.upArrow || key.downArrow)
        ) {
          setSelectedMcpServer(
            (current) => (current + (key.downArrow ? 1 : -1) + statuses.length) % statuses.length,
          );
        } else if (
          interactions.length === 0 &&
          action === 'submit' &&
          state.phase !== 'updating-mcp'
        ) {
          const status = statuses[selectedMcpServer];
          if (status !== undefined) {
            void updateMcpConnection(status.serverId, mcpServerNeedsConnection(status));
          }
        }
      } else if (action === 'close') dispatch({ type: 'overlay-closed' });
      else if (key.upArrow || key.downArrow) {
        const length =
          state.overlay === 'profiles'
            ? profiles.length
            : state.overlay === 'sessions'
              ? sessions.length
              : 0;
        if (length > 0) {
          setSelected((current) => (current + (key.downArrow ? 1 : -1) + length) % length);
        }
      } else if (action === 'submit' && state.overlay === 'profiles') {
        const profile = profiles[selected];
        if (profile !== undefined) void activateProfile(profile);
      } else if (action === 'submit' && state.overlay === 'sessions') {
        const session = sessions[selected];
        if (session !== undefined)
          void (async () => {
            const resumed = await application.resumeSession(session.id);
            if (resumed.status === 'ready') {
              dispatch({ type: 'session-created', sessionId: resumed.session.id });
            }
            dispatch({ type: 'overlay-closed' });
            dispatch({
              type: 'system-message',
              text:
                resumed.status === 'ready'
                  ? 'Restored saved profile snapshot'
                  : 'Session requires recovery',
              tone: resumed.status === 'ready' ? 'success' : 'warning',
            });
          })();
      }
      return;
    }
    if (slashHelperVisible && (key.upArrow || key.downArrow)) {
      setCommandSelection(
        (current) =>
          (current + (key.downArrow ? 1 : -1) + slashSuggestions.length) % slashSuggestions.length,
      );
    } else if (slashHelperVisible && action === 'close') {
      setCommandHelperDismissed(true);
    } else if (slashHelperVisible && action === 'submit') {
      const suggestion = slashSuggestions[commandSelection];
      if (suggestion !== undefined) submit(suggestion.command);
    } else if (action === 'scroll-up' || action === 'scroll-down' || action === 'scroll-end') {
      setScrollRequest((current) => ({
        id: (current?.id ?? 0) + 1,
        action: action === 'scroll-up' ? 'page-up' : action === 'scroll-down' ? 'page-down' : 'end',
      }));
    } else if (action === 'submit') submit();
    else if (action === 'newline')
      dispatch({ type: 'composer-changed', value: `${state.composer}\n` });
    else if (action === 'palette') void open('help');
    else if (action === 'complete') {
      const completion = slashSuggestions[commandSelection]?.command;
      if (completion !== undefined) dispatch({ type: 'composer-changed', value: completion });
    } else if (action === 'cancel') {
      const now = Date.now();
      if (state.phase === 'running') abortRef.current?.abort();
      else if (now - lastInterruptRef.current < 1000) exit();
      else
        dispatch({ type: 'system-message', text: 'Press Ctrl+C again to exit', tone: 'warning' });
      lastInterruptRef.current = now;
    } else if (key.backspace || key.delete)
      dispatch({ type: 'composer-changed', value: state.composer.slice(0, -1) });
    else if (!key.ctrl && !key.meta && input.length > 0)
      dispatch({ type: 'composer-changed', value: `${state.composer}${input}` });
  });

  const narrow = isNarrowTerminal(state.terminal.width);
  const slashHelperHeight = slashHelperVisible ? Math.min(5, slashSuggestions.length) + 3 : 0;
  const contentHeight = bodyHeight(state.terminal.height, slashHelperHeight);
  const lastConversationItem = state.conversation.at(-1);
  const showLoading = state.phase === 'running' && lastConversationItem?.kind !== 'assistant';
  const saveProvider = useCallback(
    async (configuration: ProviderConfiguration, apiKey?: string) => {
      const profileId = state.activeProfileId ?? 'default';
      const session = await application.activateModelSelection({
        profileId,
        modelRef: configuration.primaryModel,
        setup: {
          providerId: configuration.providerId,
          provider: configuration.provider,
          ...(apiKey === undefined ? {} : { apiKey }),
        },
      });
      dispatch({ type: 'profile-activated', profileId, modelRef: configuration.primaryModel });
      dispatch({ type: 'session-created', sessionId: session.id });
      dispatch({ type: 'overlay-closed' });
      setModelSetupPrefill(undefined);
      dispatch({
        type: 'system-message',
        text: `Configured ${configuration.providerId} with ${configuration.primaryModel}`,
        tone: 'success',
      });
      await refresh();
    },
    [application, refresh, state.activeProfileId],
  );

  if (startup.phase !== 'ready') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Plinthway</Text>
        {startup.phase === 'syncing' ? (
          <Text color="yellow">Syncing the model catalog from models.dev…</Text>
        ) : (
          <>
            <Text color="red">Model catalog unavailable: {startup.message}</Text>
            <Text>[R] Retry [Q] Exit</Text>
          </>
        )}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={state.terminal.width}
      minHeight={Math.min(state.terminal.height, 8)}
    >
      <Header
        {...(state.activeProfileId === undefined ? {} : { profile: state.activeProfileId })}
        {...(state.effectiveModel === undefined ? {} : { model: state.effectiveModel })}
        mcpHealth={state.mcpHealth}
        phase={state.phase}
        narrow={narrow}
      />
      <Box flexDirection="column" height={contentHeight} overflow="hidden">
        {state.overlay === undefined && (
          <Conversation
            items={state.conversation}
            height={contentHeight}
            loading={showLoading}
            {...(scrollRequest === undefined ? {} : { scrollRequest })}
          />
        )}
        {state.overlay === 'profiles' && (
          <ProfilesOverlay profiles={profiles} selected={selected} />
        )}
        {state.overlay === 'models' && (
          <ModelsOverlay
            catalog={modelCatalog}
            pickerState={modelPicker}
            height={contentHeight}
            width={state.terminal.width}
            loading={modelLoading}
            {...(modelDetail === undefined ? {} : { detail: modelDetail })}
            {...(modelError === undefined ? {} : { error: modelError })}
          />
        )}
        {state.overlay === 'mcp' && (
          <McpOverlay
            statuses={statuses}
            prompts={prompts}
            resources={resources}
            skills={skills}
            activeSkills={activeSkills}
            apps={apps}
            appSessions={appSessions}
            events={mcpEvents}
            interactions={interactions}
            tasks={mcpTasks}
            selectedServer={selectedMcpServer}
            selectedInteraction={selected}
            responseDraft={interactionResponse}
          />
        )}
        {state.overlay === 'tools' && (
          <ToolsOverlay
            tools={tools}
            policyFor={(name) =>
              activeProfile === undefined ? 'deny' : effectiveToolPolicy(activeProfile, tools, name)
            }
          />
        )}
        {state.overlay === 'sessions' && (
          <SessionsOverlay sessions={sessions} selected={selected} />
        )}
        {state.overlay === 'help' && <HelpOverlay />}
        {state.overlay === 'provider-setup' && (
          <ProviderSetupOverlay
            models={application.models?.list() ?? []}
            {...(modelSetupPrefill === undefined ? {} : { prefill: modelSetupPrefill })}
            onCancel={() => {
              if (modelSetupPrefill === undefined) dispatch({ type: 'overlay-closed' });
              else dispatch({ type: 'overlay-opened', overlay: 'models' });
            }}
            onSave={saveProvider}
            onChatGpt={() => {
              dispatch({ type: 'overlay-opened', overlay: 'chatgpt-auth' });
            }}
          />
        )}
        {state.overlay === 'chatgpt-auth' && (
          <ChatGptAuthOverlay
            application={application}
            profileId={state.activeProfileId ?? 'default'}
            onCancel={() => {
              dispatch({ type: 'overlay-closed' });
            }}
            onConfigured={async (connection, model) => {
              const profileId = state.activeProfileId ?? 'default';
              await application.configureChatGptProvider({
                profileId,
                connectionId: connection.id,
                model,
              });
              await application.switchProfile(profileId, { onBusy: 'cancel' });
              const session = await application.newSession({ profileId });
              dispatch({ type: 'profile-activated', profileId, modelRef: `chatgpt/${model.id}` });
              dispatch({ type: 'session-created', sessionId: session.id });
              dispatch({ type: 'overlay-closed' });
              dispatch({
                type: 'system-message',
                text: `Configured ChatGPT subscription with ${model.name}`,
                tone: 'success',
              });
              await refresh();
            }}
          />
        )}
        {state.overlay === 'approval' && state.approval !== undefined && (
          <ApprovalOverlay approval={state.approval} />
        )}
      </Box>
      {slashHelperVisible && <CommandHelper input={state.composer} selected={commandSelection} />}
      <Composer value={state.composer} phase={state.phase} />
      <Status
        {...(state.sessionId === undefined ? {} : { sessionId: state.sessionId })}
        narrow={narrow}
      />
    </Box>
  );
}

export interface StartTuiOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly keymap?: TuiKeymap;
}

export async function startTui(
  application: CliApplication,
  options: StartTuiOptions = {},
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const dimensions = stdout as NodeJS.WritableStream & {
    readonly columns?: number;
    readonly isTTY?: boolean;
    readonly rows?: number;
  };
  const instance = render(
    <TuiApp
      application={application}
      {...(options.keymap === undefined ? {} : { keymap: options.keymap })}
      width={dimensions.columns ?? 80}
      height={dimensions.rows ?? 24}
    />,
    {
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      stdout,
      ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
      exitOnCtrlC: false,
      interactive: dimensions.isTTY === true,
      alternateScreen: true,
    },
  );
  await instance.waitUntilRenderFlush();
  await instance.waitUntilExit();
}
