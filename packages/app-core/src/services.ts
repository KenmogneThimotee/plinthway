import type {
  AuthService,
  ChatGptAccounts,
  ChatGptModel,
  ProfileCredentialVault,
} from '@plinthway/auth';
import type { McpServerConfig } from '@plinthway/config';
import type { ModelMetadata, ModelRegistry, ProviderMetadata } from '@plinthway/model-registry';
import type { McpConnectionState, McpManager, McpServerStatus } from '@plinthway/mcp-client';
import type { ProfileCatalog, ProfileProvider } from '@plinthway/profiles';
import { McpToolProvider, type QuiesceOptions } from '@plinthway/agent-core';
import type { ApprovalPromptRouter } from '@plinthway/policy';
import {
  PlinthwayError,
  redact,
  type EffectiveProfile,
  type SessionId,
  type ToolProvider,
} from '@plinthway/shared';
import {
  defaultCatalogAdapterDeclarations,
  type CatalogAdapterDeclaration,
  type LLMRuntime,
} from '@plinthway/llm-runtime';
import type { StoredSession } from '@plinthway/sessions';

import type { NewSessionOptions, SessionCoordinator } from './session-coordinator.js';
import type {
  PreparedProfileDependencies,
  ProfileDependencyPreparer,
  SwitchCoordinator,
} from './switch-coordinator.js';
import type { ProfileSelectionCoordinator } from './profile-selection.js';
import { mergeProfileModelCatalog, type ProfileModelCatalogSnapshot } from './model-catalog.js';
import { resolveProviderCapability, type ProviderCapability } from './provider-capability.js';

export interface ConfiguredMcpServerStatus extends Omit<McpServerStatus, 'state'> {
  readonly label?: string;
  readonly enabled: boolean;
  readonly state: McpConnectionState | 'disconnected';
}

export class ServiceDependencyPreparer implements ProfileDependencyPreparer {
  readonly #llm: LLMRuntime;
  readonly #mcp: McpManager;
  readonly #mcpTools: McpToolProvider;
  readonly #nativeTools: ToolProvider;

  constructor(options: {
    readonly llm: LLMRuntime;
    readonly mcp: McpManager;
    readonly nativeTools: ToolProvider;
    readonly mcpTools?: McpToolProvider;
  }) {
    this.#llm = options.llm;
    this.#mcp = options.mcp;
    this.#nativeTools = options.nativeTools;
    this.#mcpTools = options.mcpTools ?? new McpToolProvider(options.mcp);
  }

  async prepare(profile: EffectiveProfile): Promise<PreparedProfileDependencies> {
    await this.#llm.resolve(
      profile.model.primary,
      {
        toolCalls: true,
      },
      {
        profileId: profile.id,
        providers: profile.resolvedProviders,
      },
    );
    try {
      await this.#mcp.prepare(profile.resolvedMcpServers, profile.mcp.roots, profile.generationId, {
        defaultPolicy: profile.tools.defaultPolicy,
        rules: profile.tools.rules,
      });
    } catch (error) {
      await this.#mcp.rollback();
      throw error;
    }
    return {
      tools: [...this.#nativeTools.listTools(), ...this.#mcpTools.listPreparedTools()],
      commit: () => this.#mcp.commit(),
      rollback: () => this.#mcp.rollback(),
      releaseSuperseded: () => Promise.resolve(),
    };
  }
}

export interface PlinthwayApplicationServices {
  readonly profiles: ProfileCatalog;
  readonly switching: SwitchCoordinator;
  readonly selection?: ProfileSelectionCoordinator;
  readonly sessions: SessionCoordinator;
  readonly models?: ModelRegistry;
  readonly auth?: AuthService;
  readonly credentials?: ProfileCredentialVault;
  readonly chatgpt?: ChatGptAccounts;
  readonly mcp?: McpManager;
  readonly tools?: ToolProvider;
  readonly approvalPrompts?: ApprovalPromptRouter;
  readonly registeredAdapters?: ReadonlySet<ProfileProvider['adapter']>;
  readonly catalogAdapterDeclarations?: readonly CatalogAdapterDeclaration[];
}

export class PlinthwayApplication {
  readonly #services: PlinthwayApplicationServices;

  constructor(services: PlinthwayApplicationServices) {
    this.#services = services;
  }

  initialize() {
    return this.#services.selection?.initialize() ?? this.#services.switching.initialize();
  }

  switchProfile(id: string, busy: QuiesceOptions) {
    return (
      this.#services.selection?.select(id, busy) ?? this.#services.switching.switchProfile(id, busy)
    );
  }

  deactivateProfile(busy: QuiesceOptions) {
    return this.#services.selection?.deactivate(busy) ?? this.#services.switching.deactivate(busy);
  }

  listProfiles() {
    return this.#services.profiles.list();
  }

  listTools() {
    return this.#services.tools?.listTools() ?? [];
  }

  getProfile(id: string) {
    return this.#services.profiles.get(id);
  }

  validateProfile(profile: Parameters<ProfileCatalog['validate']>[0]) {
    return this.#services.profiles.validate(profile);
  }

  createProfile(profile: Parameters<ProfileCatalog['create']>[0]) {
    return this.#services.profiles.create(profile);
  }

  updateProfile(id: string, profile: Parameters<ProfileCatalog['update']>[1]) {
    return this.#services.profiles.update(id, profile);
  }

  addMcpServer(
    profileId: string,
    serverId: string,
    server: McpServerConfig,
    options: { readonly replace?: boolean } = {},
  ) {
    return this.#services.profiles.addMcpServer(profileId, serverId, server, options);
  }

  setMcpServerEnabled(profileId: string, serverId: string, enabled: boolean): Promise<void> {
    return this.#services.profiles.setMcpServerEnabled(profileId, serverId, enabled);
  }

  setMcpServerLabel(profileId: string, serverId: string, label: string | undefined): Promise<void> {
    return this.#services.profiles.setMcpServerLabel(profileId, serverId, label);
  }

  removeMcpServer(profileId: string, serverId: string): Promise<void> {
    return this.#services.profiles.removeMcpServer(profileId, serverId);
  }

  async listMcpServers(profileId?: string): Promise<readonly ConfiguredMcpServerStatus[]> {
    const selected = profileId === undefined ? await this.initialize() : undefined;
    const id = profileId ?? selected?.id;
    if (id === undefined) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
    }
    const bundle = await this.#services.profiles.getBundle(id);
    const enabled = new Set(bundle.mcp.enabled);
    const runtime = new Map(
      (this.#services.mcp?.status() ?? []).map((status) => [status.serverId, status] as const),
    );
    return Object.keys(bundle.mcp.servers)
      .sort((left, right) => left.localeCompare(right))
      .map((serverId): ConfiguredMcpServerStatus => {
        const isEnabled = enabled.has(serverId);
        const status = isEnabled ? runtime.get(serverId) : undefined;
        const label = bundle.mcp.servers[serverId]?.label;
        const identity = { serverId, ...(label === undefined ? {} : { label }) };
        return status === undefined
          ? { ...identity, enabled: isEnabled, state: 'disconnected' }
          : { ...status, ...identity, enabled: true };
      });
  }

  deleteProfile(id: string) {
    return this.#services.profiles.delete(id);
  }

  exportProfile(id: string) {
    return this.#services.profiles.exportSanitized(id);
  }

  async configureProvider(input: {
    readonly profileId: string;
    readonly providerId: string;
    readonly provider: ProfileProvider;
    readonly apiKey?: string;
    readonly primaryModel?: string;
  }): Promise<void> {
    if (input.primaryModel !== undefined) {
      const before = await this.#services.profiles.getBundle(input.profileId);
      await this.#services.profiles.configureProviderAndModel({
        profileId: input.profileId,
        providerId: input.providerId,
        provider: input.provider,
        primaryModel: input.primaryModel,
      });
      try {
        if (input.provider.auth.mode === 'api-key' && input.apiKey !== undefined) {
          if (this.#services.credentials === undefined) {
            throw new PlinthwayError(
              'CONFIG_INVALID',
              'Profile credential vault is not configured',
            );
          }
          await this.#services.credentials.setApiKey(
            input.profileId,
            input.providerId,
            input.apiKey,
          );
        }
      } catch (error) {
        await this.#services.profiles.restoreProviderSelection(input.profileId, before);
        throw error;
      }
      return;
    }
    await this.#services.profiles.configureProvider(
      input.profileId,
      input.providerId,
      input.provider,
    );
    if (input.provider.auth.mode === 'api-key' && input.apiKey !== undefined) {
      if (this.#services.credentials === undefined) {
        throw new PlinthwayError('CONFIG_INVALID', 'Profile credential vault is not configured');
      }
      await this.#services.credentials.setApiKey(input.profileId, input.providerId, input.apiKey);
    }
  }

  async activateModelSelection(input: {
    readonly profileId: string;
    readonly modelRef: string;
    readonly setup?: {
      readonly providerId: string;
      readonly provider: ProfileProvider;
      readonly apiKey?: string;
    };
  }): Promise<StoredSession> {
    const before = await this.#services.profiles.getBundle(input.profileId);
    const previousActive = await this.initialize();
    let mutated = false;
    let switched = false;
    let createdCredential = false;
    let replacedCredential = false;
    let previousApiKey: string | undefined;
    try {
      if (input.setup === undefined) {
        await this.selectModels(input.profileId, input.modelRef);
      } else {
        const proposal = {
          profileId: input.profileId,
          providerId: input.setup.providerId,
          provider: input.setup.provider,
          primaryModel: input.modelRef,
        };
        await this.#services.profiles.validateProviderAndModel(proposal);
        if (input.setup.provider.auth.mode === 'api-key') {
          if (this.#services.credentials === undefined) {
            throw new PlinthwayError(
              'CONFIG_INVALID',
              'Profile credential vault is not configured',
            );
          }
          const existed = await this.#services.credentials.status(
            input.profileId,
            input.setup.providerId,
          );
          if (input.setup.apiKey !== undefined) {
            if (existed) {
              const previous = await this.#services.credentials.get(
                input.profileId,
                input.setup.providerId,
              );
              if (previous.type !== 'api-key') {
                throw new PlinthwayError(
                  'CONFIG_INVALID',
                  'The existing provider credential is not an API key',
                  { profileId: input.profileId, providerId: input.setup.providerId },
                );
              }
              previousApiKey = previous.secret;
            }
            await this.#services.credentials.setApiKey(
              input.profileId,
              input.setup.providerId,
              input.setup.apiKey,
            );
            createdCredential = !existed;
            replacedCredential = existed;
          } else if (!existed) {
            throw new PlinthwayError('CREDENTIAL_MISSING', 'An API key is required', {
              profileId: input.profileId,
              providerId: input.setup.providerId,
            });
          }
        }
        await this.#services.profiles.configureProviderAndModel(proposal);
      }
      mutated = true;
      await this.switchProfile(input.profileId, { onBusy: 'cancel' });
      switched = true;
      return await this.#services.sessions.newSession({ profileId: input.profileId });
    } catch (error) {
      if (mutated) {
        await this.#services.profiles
          .restoreProviderSelection(input.profileId, before)
          .catch(() => undefined);
      }
      if (
        createdCredential &&
        input.setup !== undefined &&
        this.#services.credentials !== undefined
      ) {
        await this.#services.credentials
          .deleteProvider(input.profileId, input.setup.providerId)
          .catch(() => undefined);
      } else if (
        replacedCredential &&
        previousApiKey !== undefined &&
        input.setup !== undefined &&
        this.#services.credentials !== undefined
      ) {
        await this.#services.credentials
          .setApiKey(input.profileId, input.setup.providerId, previousApiKey)
          .catch(() => undefined);
      }
      if (switched) {
        if (previousActive === undefined) {
          await this.deactivateProfile({ onBusy: 'cancel' }).catch(() => undefined);
        } else {
          await this.switchProfile(previousActive.id, { onBusy: 'cancel' }).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async configureChatGptProvider(input: {
    readonly profileId: string;
    readonly connectionId: string;
    readonly model: ChatGptModel;
  }): Promise<void> {
    await this.#services.profiles.configureChatGptProvider(
      input.profileId,
      input.connectionId,
      input.model,
    );
  }

  async listAvailableModels(profileId: string): Promise<readonly ModelMetadata[]> {
    const catalog = await this.refreshModelCatalogAccounts(profileId);
    return catalog.groups
      .filter(({ execution }) => execution.status === 'ready')
      .flatMap(({ models }) => models)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async #modelCatalog(
    profileId: string,
    refreshAccounts: boolean,
  ): Promise<ProfileModelCatalogSnapshot> {
    if (this.#services.models === undefined) {
      throw new PlinthwayError('REGISTRY_UNAVAILABLE', 'The model registry is not configured');
    }
    const bundle = await this.#services.profiles.getBundle(profileId);
    const base = this.#services.models.snapshot();
    const providerMetadata = new Map<string, ProviderMetadata>(base.providers);
    for (const [providerId, provider] of Object.entries(bundle.providers.providers)) {
      if (!providerMetadata.has(providerId)) {
        providerMetadata.set(providerId, {
          id: providerId,
          name: providerId === 'chatgpt' ? 'ChatGPT subscription' : providerId,
          env: [],
          ...(provider.baseURL === undefined ? {} : { api: provider.baseURL }),
        });
      }
    }
    const accountModels: Record<string, readonly ChatGptModel[]> = {};
    const accountRefreshErrors: Record<string, string> = {};
    let discoveredChatGpt = false;
    if (
      refreshAccounts &&
      this.#services.chatgpt !== undefined &&
      bundle.providers.providers.chatgpt === undefined
    ) {
      try {
        const connections = (await this.#services.chatgpt.listConnections()).filter(
          ({ status }) => status === 'connected',
        );
        if (connections.length > 0) {
          discoveredChatGpt = true;
          providerMetadata.set('chatgpt', {
            id: 'chatgpt',
            name: 'ChatGPT subscription',
            env: [],
          });
          const models = new Map<string, ChatGptModel>();
          for (const connection of connections) {
            try {
              for (const model of await this.#services.chatgpt.listModels(connection.id)) {
                models.set(model.id, model);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              accountRefreshErrors.chatgpt = `Account model refresh failed: ${String(
                redact(message, [message]),
              )}`;
            }
          }
          accountModels.chatgpt = [...models.values()];
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        accountRefreshErrors.chatgpt = `Account discovery failed: ${String(
          redact(message, [message]),
        )}`;
      }
    }
    const registeredAdapters =
      this.#services.registeredAdapters ??
      new Set<ProfileProvider['adapter']>([
        'openai',
        'anthropic',
        'google',
        'openai-compatible',
        ...(this.#services.chatgpt === undefined ? [] : (['openai-chatgpt'] as const)),
      ]);
    const declarations =
      this.#services.catalogAdapterDeclarations ?? defaultCatalogAdapterDeclarations();
    const capabilities = new Map<string, ProviderCapability>();
    for (const provider of providerMetadata.values()) {
      const configured = bundle.providers.providers[provider.id];
      if (provider.id === 'chatgpt' && configured === undefined && discoveredChatGpt) {
        capabilities.set(
          provider.id,
          Object.freeze({
            status: 'setup-required',
            authVariables: Object.freeze([]),
            reason: 'Select a connected ChatGPT account for this profile',
          }),
        );
        continue;
      }
      const credentialAvailable =
        configured?.auth.mode !== 'api-key'
          ? true
          : this.#services.credentials === undefined
            ? false
            : await this.#services.credentials.status(profileId, provider.id);
      capabilities.set(
        provider.id,
        resolveProviderCapability({
          provider,
          ...(configured === undefined ? {} : { configured }),
          credentialAvailable,
          registeredAdapters,
          declarations,
        }),
      );
    }

    if (refreshAccounts && this.#services.chatgpt !== undefined) {
      for (const [providerId, provider] of Object.entries(bundle.providers.providers)) {
        if (provider.adapter !== 'openai-chatgpt' || provider.auth.mode !== 'oauth') continue;
        try {
          accountModels[providerId] = await this.#services.chatgpt.listModels(
            provider.auth.connectionId,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          accountRefreshErrors[providerId] = `Account model refresh failed: ${String(
            redact(message, [message]),
          )}`;
        }
      }
    }

    return mergeProfileModelCatalog({
      base,
      providers: bundle.providers.providers,
      ...(bundle.profile.model.primary === undefined
        ? {}
        : { current: bundle.profile.model.primary }),
      capabilities,
      accountModels,
      accountRefreshErrors,
      cached: this.#services.models.catalogStatus().source === 'cache',
    });
  }

  getModelCatalog(profileId: string): Promise<ProfileModelCatalogSnapshot> {
    return this.#modelCatalog(profileId, false);
  }

  refreshModelCatalogAccounts(profileId: string): Promise<ProfileModelCatalogSnapshot> {
    return this.#modelCatalog(profileId, true);
  }

  signInChatGpt(options: Parameters<ChatGptAccounts['signIn']>[0]) {
    if (this.#services.chatgpt === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'ChatGPT account service is not configured');
    }
    return this.#services.chatgpt.signIn(options);
  }

  listChatGptAccounts() {
    if (this.#services.chatgpt === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'ChatGPT account service is not configured');
    }
    return this.#services.chatgpt.listConnections();
  }

  listChatGptModels(connectionId: string, signal?: AbortSignal) {
    if (this.#services.chatgpt === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'ChatGPT account service is not configured');
    }
    return this.#services.chatgpt.listModels(connectionId, signal);
  }

  disconnectChatGpt(connectionId: string) {
    if (this.#services.chatgpt === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'ChatGPT account service is not configured');
    }
    return this.#services.chatgpt.disconnect(connectionId);
  }

  async selectModels(
    profileId: string,
    primary: string,
    fallback: readonly string[] = [],
  ): Promise<void> {
    const separator = primary.indexOf('/');
    const providerId = separator < 0 ? '' : primary.slice(0, separator);
    const modelId = separator < 0 ? '' : primary.slice(separator + 1);
    const bundle = await this.#services.profiles.getBundle(profileId);
    const provider = bundle.providers.providers[providerId];

    if (
      provider?.adapter === 'openai-chatgpt' &&
      provider.auth.mode === 'oauth' &&
      provider.models[modelId] === undefined
    ) {
      if (this.#services.chatgpt === undefined) {
        throw new PlinthwayError('CONFIG_INVALID', 'ChatGPT account service is not configured');
      }
      const model = (await this.#services.chatgpt.listModels(provider.auth.connectionId)).find(
        (candidate) => candidate.id === modelId,
      );
      if (model === undefined) {
        throw new PlinthwayError('MODEL_NOT_FOUND', `Model ${primary} was not found`, {
          modelId: primary,
          profileId,
        });
      }
      await this.#services.profiles.configureChatGptProvider(
        profileId,
        provider.auth.connectionId,
        model,
      );
      if (fallback.length > 0) {
        await this.#services.profiles.selectModels(profileId, primary, fallback);
      }
      return;
    }

    await this.#services.profiles.selectModels(profileId, primary, fallback);
  }

  setProviderApiKey(profileId: string, providerId: string, secret: string): Promise<void> {
    if (this.#services.credentials === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'Profile credential vault is not configured');
    }
    return this.#services.credentials.setApiKey(profileId, providerId, secret);
  }

  deleteProviderCredential(profileId: string, providerId: string): Promise<void> {
    if (this.#services.credentials === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'Profile credential vault is not configured');
    }
    return this.#services.credentials.deleteProvider(profileId, providerId);
  }

  providerCredentialStatus(profileId: string, providerId: string): Promise<boolean> {
    if (this.#services.credentials === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'Profile credential vault is not configured');
    }
    return this.#services.credentials.status(profileId, providerId);
  }

  async prepareMcp(profileId?: string): Promise<void> {
    if (this.#services.mcp === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', 'MCP service is not configured');
    }
    const selected = profileId === undefined ? await this.initialize() : undefined;
    const id = profileId ?? selected?.id;
    if (id === undefined) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
    }
    const profile = await this.#services.profiles.resolveMcp(id);
    await this.#services.mcp.prepare(
      profile.resolvedMcpServers,
      profile.mcp.roots,
      profile.generationId,
      profile.tools,
    );
    try {
      await this.#services.mcp.commit();
    } catch (error) {
      await this.#services.mcp.rollback();
      throw error;
    }
  }

  run(
    prompt: string,
    options: NewSessionOptions & {
      readonly sessionId?: SessionId;
      readonly signal?: AbortSignal;
    } = {},
  ) {
    return this.#services.sessions.run(prompt, options);
  }

  newSession(options: NewSessionOptions = {}) {
    return this.#services.sessions.newSession(options);
  }

  listSessions() {
    return this.#services.sessions.listDurable();
  }

  resumeSession(id: SessionId) {
    return this.#services.sessions.resume(id);
  }

  branchSession(
    id: SessionId,
    options: NewSessionOptions & {
      readonly atSequence?: number;
      readonly skipDependencyPreparation?: boolean;
    },
  ) {
    return this.#services.sessions.branch(id, options);
  }

  get models(): ModelRegistry | undefined {
    return this.#services.models;
  }

  get auth(): AuthService | undefined {
    return this.#services.auth;
  }

  get mcp(): McpManager | undefined {
    return this.#services.mcp;
  }

  get approvalPrompts(): ApprovalPromptRouter | undefined {
    return this.#services.approvalPrompts;
  }
}
