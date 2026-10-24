import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { select } from '@inquirer/prompts';
import { stringify } from 'yaml';

import {
  AgentEngine,
  CompositeToolProvider,
  ExecutionGate,
  McpToolProvider,
} from '@plinthway/agent-core';
import {
  PlinthwayApplication,
  ProfileSelectionCoordinator,
  ServiceDependencyPreparer,
  SessionCoordinator,
  SwitchCoordinator,
} from '@plinthway/app-core';
import {
  ChatGptAccountService,
  createDefaultAuthService,
  KeyringCredentialStore,
  NativeChatGptOAuth,
  ProfileCredentialVault,
} from '@plinthway/auth';
import open from 'open';
import {
  atomicWriteFile,
  loadGlobalConfig,
  loadManagedAuthorizationConfig,
  migrateLegacyHarnessState,
  resolveLegacyHarnessPaths,
  resolveLegacyManagedAuthorizationPath,
  resolvePlinthwayPaths,
  resolveManagedAuthorizationPath,
  type PlinthwayPaths,
} from '@plinthway/config';
import {
  createDefaultAdapterFactories,
  ProfileModelResolver,
  UnifiedLLMRuntime,
} from '@plinthway/llm-runtime';
import { FilesystemToolProvider, ShellToolProvider } from '@plinthway/local-tools';
import {
  connectMcpServer,
  createClientCredentialsProvider,
  createEnterpriseAuthorizationProvider,
  createRestrictedFetch,
  EnterpriseOidcAuthorizationController,
  PlinthwayOAuthClientProvider,
  McpManager,
  McpOAuthController,
  type McpAppApprovalRequest,
  type ConnectMcpServerOptions,
} from '@plinthway/mcp-client';
import { CatalogCache, ModelRegistry } from '@plinthway/model-registry';
import { ApprovalBroker, ApprovalPromptRouter, invocationIdentity } from '@plinthway/policy';
import { FileProfileRepository, ProfileCatalog } from '@plinthway/profiles';
import {
  MemorySessionRepository,
  recoverInterrupted,
  SessionDatabase,
  SqliteActiveProfileStore,
  SqliteMcpTaskRepository,
  SqliteSelectedProfileStore,
  SqliteSessionRepository,
  SqliteTransitionRepository,
  type SessionRepository,
} from '@plinthway/sessions';
import {
  asExecutionId,
  asSessionId,
  PlinthwayError,
  registerRedactionSecret,
  type EffectiveProfile,
  type JsonValue,
} from '@plinthway/shared';

import type { CliApplication, TextWriter } from './application.js';

export interface BootstrapOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: TextWriter;
}

export interface BootstrappedApplication {
  readonly application: CliApplication;
  readonly paths: PlinthwayPaths;
  readonly initializeHome: (force: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
}

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  registry: {
    source: 'https://models.dev/api.json',
    cache: true,
    refreshIntervalHours: 24,
  },
  providers: {
    openai: { adapter: 'openai', authPlugin: 'openai-api-key', models: {} },
    anthropic: { adapter: 'anthropic', authPlugin: 'anthropic-api-key', models: {} },
    google: { adapter: 'google', authPlugin: 'google-api-key', models: {} },
    local: {
      adapter: 'openai-compatible',
      authPlugin: 'none',
      baseURL: 'http://127.0.0.1:11434/v1',
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
} as const;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function prepareSessionDependencies(
  dependencyPreparer: Pick<ServiceDependencyPreparer, 'prepare'>,
  profile: EffectiveProfile,
): Promise<void> {
  const prepared = await dependencyPreparer.prepare(profile);
  try {
    await prepared.commit();
  } catch (error) {
    await prepared.rollback();
    throw error;
  }
}

function invocationTargets(value: JsonValue): readonly string[] {
  const targets = new Set<string>();
  const visit = (candidate: JsonValue): void => {
    if (typeof candidate === 'string') {
      if (/^(?:https?:\/\/|file:\/\/|\.{0,2}[\\/]|[A-Za-z]:[\\/])/u.test(candidate)) {
        targets.add(candidate);
      }
    } else if (Array.isArray(candidate)) {
      for (const entry of candidate as readonly JsonValue[]) visit(entry);
    } else if (candidate !== null && typeof candidate === 'object') {
      for (const entry of Object.values(candidate)) visit(entry);
    }
  };
  visit(value);
  return [...targets].sort();
}

export async function createApplication(
  options: BootstrapOptions = {},
): Promise<BootstrappedApplication> {
  const environment = options.env ?? process.env;
  const currentDirectory = path.resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homedir ?? homedir();
  const paths = resolvePlinthwayPaths(platform, environment, homeDirectory);
  const legacyPaths = resolveLegacyHarnessPaths(platform, environment, homeDirectory);
  await migrateLegacyHarnessState({ legacy: legacyPaths, target: paths });
  const initializeHome = async (force: boolean): Promise<void> => {
    await Promise.all([
      mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 }),
      mkdir(paths.data, { recursive: true, mode: 0o700 }),
      mkdir(paths.cache, { recursive: true, mode: 0o700 }),
      mkdir(paths.profiles, { recursive: true, mode: 0o700 }),
    ]);
    if (force || !(await exists(paths.config))) {
      await atomicWriteFile(paths.config, stringify(DEFAULT_CONFIG));
    }
  };

  await initializeHome(false);

  const loaded = await loadGlobalConfig({
    configPath: paths.config,
    env: environment,
    workspace: currentDirectory,
  });
  const managedAuthorization = await loadManagedAuthorizationConfig({
    path: resolveManagedAuthorizationPath(platform, environment),
    fallbackPath: resolveLegacyManagedAuthorizationPath(platform),
    platform,
  });
  const database = new SessionDatabase(paths.database);
  const durable = new SqliteSessionRepository(database);
  const mcpTasks = new SqliteMcpTaskRepository(database);
  const memory = new MemorySessionRepository();
  await recoverInterrupted(durable);
  const activeStore = new SqliteActiveProfileStore(database);
  const selectedStore = new SqliteSelectedProfileStore(database);
  const transitions = new SqliteTransitionRepository(database);
  const auth = createDefaultAuthService({ environment, credentialsFile: paths.credentials });
  const credentialVault = new ProfileCredentialVault(new KeyringCredentialStore());
  const chatgpt = new ChatGptAccountService({
    accountsFile: paths.chatgptAccounts,
    hostFile: paths.chatgptHost,
    modelCacheFile: paths.chatgptModelCache,
    oauth: new NativeChatGptOAuth({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      openUrl: async (url) => {
        await open(url, { wait: false });
      },
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const registry = new ModelRegistry({
    config: loaded.config,
    cache: new CatalogCache(paths.cache),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    adapterSupported: () => true,
    credentialsAvailable: () => false,
  });
  await registry.loadCached().catch(() => false);
  const resolver = new ProfileModelResolver({
    registry,
    credentials: credentialVault,
    adapterFactories: createDefaultAdapterFactories({
      chatgpt,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  });
  const llm = new UnifiedLLMRuntime({ resolver });
  const mcpOAuth = new McpOAuthController();
  const enterpriseOidc = new EnterpriseOidcAuthorizationController();
  const mcpOAuthStore = new KeyringCredentialStore();
  let approveAppInvocation: (request: McpAppApprovalRequest) => Promise<boolean> = () =>
    Promise.resolve(false);
  const mcp = new McpManager({
    oauth: mcpOAuth,
    taskRepository: mcpTasks,
    approveSkill: async (request) => {
      if (options.stdin?.isTTY !== true) return false;
      const decision = await select({
        message: `Load untrusted MCP skill ${request.serverId}:${request.uri}?${request.requestsAllowedTools ? ' Its allowed-tools field will not grant permissions.' : ''}`,
        choices: [
          { name: 'Deny', value: false },
          { name: 'Load this verified manifest', value: true },
        ],
        default: false,
      });
      return decision;
    },
    approveApp: (request) => approveAppInvocation(request),
    connect: async (server, connectionOptions) => {
      let credentialHeaders: Readonly<Record<string, string>> | undefined;
      let oauthProvider: NonNullable<ConnectMcpServerOptions['oauthProvider']> | undefined;
      let isOAuthCredentialDestination: ((url: URL) => boolean) | undefined;
      if (server.transport === 'streamable-http' && server.authPlugin !== undefined) {
        const credential = await auth.getCredentials(server.authPlugin);
        if (credential.type === 'api-key') {
          credentialHeaders = { Authorization: `Bearer ${credential.secret}` };
        }
      }
      if (
        server.transport === 'streamable-http' &&
        server.auth?.mode === 'bearer' &&
        server.auth.credential.source === 'keyring'
      ) {
        const credential = await mcpOAuthStore.get(server.auth.credential.id);
        if (credential?.type !== 'api-key') {
          throw new PlinthwayError(
            'CREDENTIAL_MISSING',
            `MCP credential is unavailable for ${server.id}`,
            {
              serverId: server.id,
            },
          );
        }
        registerRedactionSecret(credential.secret);
        credentialHeaders = { Authorization: `Bearer ${credential.secret}` };
      }
      if (server.transport === 'streamable-http' && server.auth?.mode === 'oauth') {
        const configuredRedirect = environment.PLINTHWAY_MCP_OAUTH_REDIRECT_URI;
        const interactiveProvider = new PlinthwayOAuthClientProvider({
          serverId: server.id,
          serverUrl: server.url,
          redirectUrl: configuredRedirect ?? 'http://127.0.0.1/oauth/callback',
          ...(server.auth.clientId === undefined ? {} : { clientId: server.auth.clientId }),
          ...(server.auth.clientIdMetadataDocument === undefined
            ? {}
            : { clientMetadataUrl: server.auth.clientIdMetadataDocument }),
          scopes: server.auth.scopes,
          store: mcpOAuthStore,
          deferAuthorizationRedirect: true,
          redirectToAuthorization: (authorizationUrl) => {
            void open(authorizationUrl.href, { wait: false }).catch(() => undefined);
          },
        });
        oauthProvider = interactiveProvider;
        const oauthFetch = createRestrictedFetch({
          originalUrl: new URL(server.url),
          allowedOrigins: loaded.config.security.allowedHttpOrigins,
          credentialHeaderNames: [],
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        mcpOAuth.register(
          server.id,
          server.url,
          interactiveProvider,
          server.auth.scopes,
          oauthFetch,
          { automaticLoopback: configuredRedirect === undefined },
        );
      }
      if (server.transport === 'streamable-http' && server.auth?.mode === 'client-credentials') {
        const machineProvider = await createClientCredentialsProvider({
          serverId: server.id,
          serverUrl: server.url,
          auth: server.auth,
          store: mcpOAuthStore,
        });
        oauthProvider = machineProvider;
        isOAuthCredentialDestination = (url) => machineProvider.isCredentialDestination(url);
      }
      if (server.transport === 'streamable-http' && server.auth?.mode === 'enterprise') {
        const profile = managedAuthorization.profiles[server.auth.managedProfile];
        if (profile === undefined) {
          throw new PlinthwayError(
            'CONFIG_INVALID',
            `Managed enterprise authorization profile ${server.auth.managedProfile} does not exist`,
            { serverId: server.id },
          );
        }
        const managedOrigins = [
          ...loaded.config.security.allowedHttpOrigins,
          profile.issuer,
          ...profile.resources.flatMap((resource) => [
            resource.resource,
            resource.authorizationServer,
          ]),
        ];
        const enterpriseFetch = createRestrictedFetch({
          originalUrl: new URL(profile.issuer),
          allowedOrigins: managedOrigins,
          credentialHeaderNames: [],
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        mcpOAuth.registerHandler(
          server.id,
          enterpriseOidc.register(server.id, {
            managedProfile: server.auth.managedProfile,
            profile,
            store: mcpOAuthStore,
            fetch: enterpriseFetch,
          }),
        );
        const enterpriseProvider = await createEnterpriseAuthorizationProvider({
          serverId: server.id,
          serverUrl: server.url,
          managedProfile: server.auth.managedProfile,
          profile,
          store: mcpOAuthStore,
          fetch: enterpriseFetch,
        });
        oauthProvider = enterpriseProvider;
        isOAuthCredentialDestination = (url) => enterpriseProvider.isCredentialDestination(url);
      }
      return connectMcpServer(server, {
        allowedHttpOrigins: loaded.config.security.allowedHttpOrigins,
        environment,
        ...(credentialHeaders === undefined ? {} : { credentialHeaders }),
        ...(isOAuthCredentialDestination === undefined ? {} : { isOAuthCredentialDestination }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(oauthProvider === undefined ? {} : { oauthProvider }),
        ...(connectionOptions?.responseCacheStore === undefined
          ? {}
          : { responseCacheStore: connectionOptions.responseCacheStore }),
        ...(connectionOptions?.cachePartition === undefined
          ? {}
          : { cachePartition: connectionOptions.cachePartition }),
        ...(connectionOptions?.interactionBroker === undefined
          ? {}
          : { interactionBroker: connectionOptions.interactionBroker }),
      });
    },
  });
  enterpriseOidc.setOnAuthorized((serverId) => {
    mcp.reconnect(serverId);
  });
  const filesystemTools = await FilesystemToolProvider.create({ workspace: currentDirectory });
  const shellTools = await ShellToolProvider.create({
    workspace: currentDirectory,
    environment,
  });
  const nativeTools = new CompositeToolProvider([filesystemTools, shellTools]);
  const mcpTools = new McpToolProvider(mcp);
  const tools = new CompositeToolProvider([nativeTools, mcpTools]);
  const profileRepository = new FileProfileRepository(paths.profiles);
  const profiles = new ProfileCatalog({
    repository: profileRepository,
    config: loaded.config,
    registry,
    activeStore,
    instructionRoots: [currentDirectory, paths.profiles],
    environment,
  });
  await profiles.ensureDefaultIfEmpty();
  const gate = new ExecutionGate();
  const dependencyPreparer = new ServiceDependencyPreparer({ llm, mcp, nativeTools, mcpTools });
  const coordinators: { sessions?: SessionCoordinator } = {};
  const approvalPrompts = new ApprovalPromptRouter(async (request) => {
    if (options.stdin?.isTTY !== true) return 'deny';
    return select({
      message: `Allow ${request.toolName} once?`,
      choices: [
        { name: 'Deny', value: 'deny' as const },
        { name: 'Allow once', value: 'allow-once' as const },
      ],
      default: 'deny',
    });
  });
  const approvals = new ApprovalBroker({
    prompt: (_identity, details) => {
      if (details === undefined) return Promise.resolve('deny');
      return approvalPrompts.request(details);
    },
    persist: async (decision) => {
      if (coordinators.sessions === undefined) {
        throw new PlinthwayError('STORAGE_ERROR', 'Session coordinator is unavailable');
      }
      await coordinators.sessions.persistApproval(decision);
      approvalPrompts.decisionPersisted(decision);
    },
  });
  approveAppInvocation = async (request): Promise<boolean> => {
    const toolName = `${request.serverId}.${request.toolName}`;
    const identity = invocationIdentity({
      sessionId: asSessionId(request.auditSessionId),
      executionId: asExecutionId(`mcp-app-${request.appSessionId}`),
      profileGenerationId: request.profileGenerationId,
      callId: request.callId,
      toolName,
      arguments: request.arguments,
    });
    const outcome = await approvals.request(identity, {
      identity,
      serverId: request.serverId,
      toolName,
      arguments: request.arguments,
      targets: invocationTargets(request.arguments),
      readOnlyHint: request.readOnlyHint,
      sideEffects: request.readOnlyHint ? 'none anticipated' : 'may modify external state',
    });
    return outcome.decision === 'allow-once' && approvals.consume(outcome.grant, identity);
  };
  const engineFor = (repository: SessionRepository) =>
    new AgentEngine({
      llm,
      tools,
      skillContexts: () => mcpTools.listActiveSkillContexts(),
      approvals,
      sessions: repository,
      gate,
      stderr: options.stderr ?? process.stderr,
    });
  const sessions = new SessionCoordinator({
    durable,
    memory,
    activeStore,
    selectedStore,
    profiles,
    currentMcpEnabled: async (profileId) => (await profiles.getBundle(profileId)).mcp.enabled,
    engineFor,
    prepareSnapshot: (profile) => prepareSessionDependencies(dependencyPreparer, profile),
  });
  coordinators.sessions = sessions;
  const switching = new SwitchCoordinator({
    profiles,
    activeStore,
    dependencies: dependencyPreparer,
    executionGate: gate,
    transitions,
    approvals,
  });
  const selection = new ProfileSelectionCoordinator({
    profiles,
    store: selectedStore,
    executionGate: gate,
    approvals,
  });
  const application = new PlinthwayApplication({
    profiles,
    switching,
    selection,
    sessions,
    models: registry,
    auth,
    credentials: credentialVault,
    chatgpt,
    mcp,
    tools,
    approvalPrompts,
  });
  await application.initialize();
  return {
    application,
    paths,
    initializeHome,
    close: async () => {
      gate.cancel();
      await gate.waitForIdle();
      await mcp.disconnect();
      database.close();
    },
  };
}
