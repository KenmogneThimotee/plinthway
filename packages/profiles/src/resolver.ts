import {
  expandPublicEnvironment,
  runtimeOverridesSchema,
  type GlobalConfig,
  type RuntimeOverrides,
} from '@plinthway/config';
import {
  canonicalJson,
  deepFreeze,
  PlinthwayError,
  sha256,
  type EffectiveProfile,
  type PublicMcpServerConfig,
  type WorkProfile,
} from '@plinthway/shared';

import type { ResolvedInstructions } from './validator.js';
import type { ProfileMcp, ProfileProviders } from './schema.js';

async function resolveServer(
  id: string,
  server: GlobalConfig['mcpServers'][string],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<PublicMcpServerConfig> {
  if (server.transport === 'stdio') {
    return {
      id,
      transport: 'stdio',
      command: await expandPublicEnvironment(server.command, environment),
      args: await Promise.all(
        server.args.map(async (value) => expandPublicEnvironment(value, environment)),
      ),
      ...(server.cwd === undefined
        ? {}
        : { cwd: await expandPublicEnvironment(server.cwd, environment) }),
      env: [...server.env],
      extensions: { ...server.extensions },
    };
  }
  return {
    id,
    transport: 'streamable-http',
    url: await expandPublicEnvironment(server.url, environment),
    ...('authPlugin' in server ? { authPlugin: server.authPlugin } : {}),
    auth: server.auth,
    extensions: { ...server.extensions },
  };
}

export interface ResolveSnapshotOptions {
  readonly profile: WorkProfile;
  readonly config: GlobalConfig;
  readonly overrides?: RuntimeOverrides;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly instructions?: ResolvedInstructions;
  readonly providers?: ProfileProviders;
  readonly mcp?: ProfileMcp;
}

export interface ResolveMcpProfileOptions {
  readonly profile: WorkProfile;
  readonly config: GlobalConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly mcp?: ProfileMcp;
}

export interface ResolvedMcpProfile {
  readonly profileId: WorkProfile['id'];
  readonly generationId: string;
  readonly mcp: {
    readonly enabled: readonly string[];
    readonly roots: ProfileMcp['roots'];
  };
  readonly tools: WorkProfile['tools'];
  readonly resolvedMcpServers: readonly PublicMcpServerConfig[];
}

export async function resolveMcpProfile(
  options: ResolveMcpProfileOptions,
): Promise<ResolvedMcpProfile> {
  const enabledServers = options.mcp?.enabled ?? options.profile.mcp?.enabled ?? [];
  const serverDefinitions = options.mcp?.servers ?? options.config.mcpServers;
  const resolvedMcpServers = await Promise.all(
    enabledServers.map(async (id) => {
      const server = serverDefinitions[id];
      if (server === undefined) {
        throw new PlinthwayError('PROFILE_INVALID', `MCP server ${id} is not configured`, {
          profileId: options.profile.id,
          serverId: id,
        });
      }
      return resolveServer(id, server, options.environment);
    }),
  );
  const resolvedWithoutGeneration = {
    profileId: options.profile.id,
    mcp: {
      enabled: [...enabledServers],
      roots: (options.mcp?.roots ?? []).map((root) => ({ ...root })),
    },
    tools: {
      defaultPolicy: options.profile.tools.defaultPolicy,
      rules: options.profile.tools.rules.map((rule) => ({ ...rule })),
    },
    resolvedMcpServers,
  };
  return deepFreeze({
    ...resolvedWithoutGeneration,
    generationId: sha256(canonicalJson(resolvedWithoutGeneration)),
  });
}

export async function resolveSnapshot(options: ResolveSnapshotOptions): Promise<EffectiveProfile> {
  const overrides = runtimeOverridesSchema.parse(options.overrides ?? {});
  const primary = overrides.model ?? options.profile.model.primary;
  if (primary === undefined) {
    throw new Error(`Profile ${options.profile.id} has no primary model`);
  }
  const environment = {
    ...options.environment,
    ...(overrides.workspace === undefined ? {} : { WORKSPACE: overrides.workspace }),
  };
  const resolvedMcp = await resolveMcpProfile({
    profile: options.profile,
    config: options.config,
    environment,
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
  });
  const snapshotWithoutGeneration = {
    schemaVersion: 1 as const,
    id: options.profile.id,
    name: options.profile.name,
    ...(options.profile.description === undefined
      ? {}
      : { description: options.profile.description }),
    model: {
      primary,
      fallback: [...options.profile.model.fallback],
      parameters: { ...options.profile.model.parameters },
    },
    mcp: resolvedMcp.mcp,
    tools: resolvedMcp.tools,
    agent: {
      maxSteps: overrides.maxSteps ?? options.profile.agent.maxSteps,
      ...((overrides.toolTimeoutSeconds ?? options.profile.agent.toolTimeoutSeconds) === undefined
        ? {}
        : {
            toolTimeoutSeconds:
              overrides.toolTimeoutSeconds ?? options.profile.agent.toolTimeoutSeconds,
          }),
    },
    session: { persist: overrides.persist ?? options.profile.session.persist },
    ...(options.instructions === undefined
      ? {}
      : { resolvedInstructions: options.instructions.content }),
    resolvedMcpServers: resolvedMcp.resolvedMcpServers,
    resolvedProviders: Object.fromEntries(
      Object.entries(options.providers?.providers ?? {}).map(([id, provider]) => [
        id,
        {
          adapter: provider.adapter,
          ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
          auth: provider.auth,
          models: provider.models,
        },
      ]),
    ),
  };
  const generationId = sha256(canonicalJson(snapshotWithoutGeneration));
  return deepFreeze({ ...snapshotWithoutGeneration, generationId });
}
