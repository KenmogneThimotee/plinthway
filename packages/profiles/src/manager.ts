import {
  mcpServerLabelSchema,
  mcpServerSchema,
  runtimeOverridesSchema,
  serverIdSchema,
  type GlobalConfig,
  type McpServerConfig,
  type RuntimeOverrides,
} from '@plinthway/config';
import { ProfileModelCatalog } from '@plinthway/model-registry';
import { PlinthwayError, type EffectiveProfile, type WorkProfile } from '@plinthway/shared';
import type { ZodError } from 'zod';

import { sanitizeProfileExport, type SanitizedProfileExport } from './export.js';
import type { FileProfileRepository, ProfileRecord } from './repository.js';
import { resolveMcpProfile, resolveSnapshot } from './resolver.js';
import { workProfileSchema } from './schema.js';
import type { ProfileBundle, ProfileMcp, ProfileProvider, ProfileProviders } from './schema.js';
import {
  validateProfile,
  type DetailedValidationResult,
  type ModelRegistryLookup,
  type ProfileValidationIssue,
  type ProfileValidationResult,
} from './validator.js';

export interface ActiveProfileStore {
  readonly get: () => Promise<EffectiveProfile | undefined>;
}

export interface ProfileCatalogOptions {
  readonly repository: FileProfileRepository;
  readonly config: GlobalConfig;
  readonly registry: ModelRegistryLookup;
  readonly activeStore: ActiveProfileStore;
  readonly instructionRoots: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface ProviderModelSelectionInput {
  readonly profileId: string;
  readonly providerId: string;
  readonly provider: ProfileProvider;
  readonly primaryModel: string;
  readonly fallback?: readonly string[];
}

function schemaIssues(error: ZodError): readonly ProfileValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'schema-invalid',
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function throwInvalid(result: ProfileValidationResult): never {
  throw new PlinthwayError('PROFILE_INVALID', 'Profile validation failed', {
    issues: result.issues.map((issue) => ({ ...issue })),
  });
}

export class ProfileCatalog {
  readonly #options: ProfileCatalogOptions;

  constructor(options: ProfileCatalogOptions) {
    this.#options = options;
  }

  async #validateRecord(
    record: Pick<ProfileRecord, 'profile' | 'sourcePath'> &
      Partial<Pick<ProfileRecord, 'providers' | 'mcp'>>,
    environment = this.#options.environment,
  ): Promise<DetailedValidationResult> {
    return validateProfile({
      profile: record.profile,
      sourcePath: record.sourcePath,
      config: this.#options.config,
      registry:
        record.providers === undefined
          ? this.#options.registry
          : new ProfileModelCatalog(this.#options.registry, record.providers.providers),
      instructionRoots: this.#options.instructionRoots,
      environment,
      ...(record.providers === undefined ? {} : { providers: record.providers.providers }),
      ...(record.mcp === undefined ? {} : { mcpServers: record.mcp.servers }),
    });
  }

  async list(): Promise<readonly WorkProfile[]> {
    return (await this.#options.repository.list()).map((record) => record.profile);
  }

  async get(id: string): Promise<WorkProfile> {
    return (await this.#options.repository.get(id)).profile;
  }

  getBundle(id: string) {
    return this.#options.repository.get(id);
  }

  ensureDefaultIfEmpty() {
    return this.#options.repository.ensureDefaultIfEmpty();
  }

  async updateProviders(id: string, providers: ProfileProviders): Promise<void> {
    await this.#options.repository.updateProviders(id, providers);
  }

  async configureProvider(
    id: string,
    providerId: string,
    provider: ProfileProvider,
  ): Promise<void> {
    const record = await this.#options.repository.get(id);
    const providers: ProfileProviders = {
      schemaVersion: 1,
      providers: { ...record.providers.providers, [providerId]: provider },
    };
    await this.#options.repository.updateProviders(id, providers);
  }

  async configureProviderAndModel(input: {
    readonly profileId: string;
    readonly providerId: string;
    readonly provider: ProfileProvider;
    readonly primaryModel: string;
    readonly fallback?: readonly string[];
  }): Promise<void> {
    const proposal = await this.#providerSelection(input);
    await this.#options.repository.updateProviderSelection(
      input.profileId,
      proposal.providers,
      proposal.profile,
    );
  }

  async validateProviderAndModel(input: ProviderModelSelectionInput): Promise<void> {
    await this.#providerSelection(input);
  }

  async #providerSelection(input: ProviderModelSelectionInput): Promise<{
    readonly providers: ProfileProviders;
    readonly profile: WorkProfile;
  }> {
    const record = await this.#options.repository.get(input.profileId);
    const providers: ProfileProviders = {
      schemaVersion: 1,
      providers: {
        ...record.providers.providers,
        [input.providerId]: input.provider,
      },
    };
    const profile: WorkProfile = {
      ...record.profile,
      model: {
        ...record.profile.model,
        primary: input.primaryModel,
        fallback: [...(input.fallback ?? [])],
      },
    };
    const result = await this.#validateRecord({ ...record, profile, providers });
    if (!result.valid) throwInvalid(result);
    return { providers, profile };
  }

  async restoreProviderSelection(
    id: string,
    snapshot: Pick<ProfileRecord, 'profile' | 'providers'>,
  ): Promise<void> {
    await this.#options.repository.updateProviderSelection(
      id,
      snapshot.providers,
      snapshot.profile,
    );
  }

  async configureChatGptProvider(
    id: string,
    connectionId: string,
    model: { readonly id: string; readonly name: string },
  ): Promise<void> {
    const record = await this.#options.repository.get(id);
    const existing = record.providers.providers.chatgpt;
    const existingModels =
      existing?.adapter === 'openai-chatgpt' &&
      existing.auth.mode === 'oauth' &&
      existing.auth.connectionId === connectionId
        ? existing.models
        : {};
    const providers: ProfileProviders = {
      schemaVersion: 1,
      providers: {
        ...record.providers.providers,
        chatgpt: {
          adapter: 'openai-chatgpt',
          auth: { mode: 'oauth', service: 'chatgpt', connectionId },
          models: {
            ...existingModels,
            [model.id]: {
              name: model.name,
              toolCalls: true,
              reasoning: true,
              structuredOutput: true,
            },
          },
        },
      },
    };
    const profile: WorkProfile = {
      ...record.profile,
      model: {
        primary: `chatgpt/${model.id}`,
        fallback: [],
        parameters: { ...record.profile.model.parameters },
      },
    };
    const result = await this.#validateRecord({ ...record, profile, providers });
    if (!result.valid) throwInvalid(result);
    await this.#options.repository.updateProviders(id, providers);
    await this.#options.repository.update(id, profile);
  }

  async selectModels(id: string, primary: string, fallback: readonly string[] = []): Promise<void> {
    const record = await this.#options.repository.get(id);
    const profile: WorkProfile = {
      ...record.profile,
      model: { ...record.profile.model, primary, fallback: [...fallback] },
    };
    const result = await this.#validateRecord({ ...record, profile });
    if (!result.valid) throwInvalid(result);
    await this.#options.repository.update(id, profile);
  }

  async updateMcp(id: string, mcp: ProfileMcp): Promise<void> {
    await this.#options.repository.updateMcp(id, mcp);
  }

  async addMcpServer(
    id: string,
    serverId: string,
    server: McpServerConfig,
    options: { readonly replace?: boolean } = {},
  ): Promise<void> {
    const record = await this.#options.repository.get(id);
    if (!serverIdSchema.safeParse(serverId).success) {
      throw new PlinthwayError(
        'CONFIG_INVALID',
        `MCP server id ${serverId} is invalid or reserved`,
        {
          profileId: id,
          serverId,
        },
      );
    }
    if (record.mcp.servers[serverId] !== undefined && options.replace !== true) {
      throw new PlinthwayError('CONFIG_INVALID', `MCP server ${serverId} already exists`, {
        profileId: id,
        serverId,
      });
    }
    const parsed = mcpServerSchema.safeParse(server);
    if (!parsed.success) {
      throw new PlinthwayError('CONFIG_INVALID', 'MCP server configuration is invalid', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const existing = record.mcp.servers[serverId];
    const parsedServer =
      options.replace === true && existing?.label !== undefined && parsed.data.label === undefined
        ? { ...parsed.data, label: existing.label }
        : parsed.data;
    const mcp: ProfileMcp = {
      schemaVersion: 2,
      servers: { ...record.mcp.servers, [serverId]: parsedServer },
      enabled: [...record.mcp.enabled],
      roots: [...record.mcp.roots],
    };
    const wildcard = `${serverId}.*`;
    const profile: WorkProfile = {
      ...record.profile,
      mcp: {
        enabled: [...(record.profile.mcp?.enabled ?? [])],
      },
      tools: {
        ...record.profile.tools,
        rules: record.profile.tools.rules.some((rule) => rule.tool === wildcard)
          ? [...record.profile.tools.rules]
          : [...record.profile.tools.rules, { tool: wildcard, action: 'ask' }],
      },
    };

    await this.#options.repository.updateMcp(id, mcp);
    try {
      await this.update(id, profile);
    } catch (error) {
      await this.#options.repository.updateMcp(id, record.mcp);
      throw error;
    }
  }

  async setMcpServerLabel(id: string, serverId: string, label: string | undefined): Promise<void> {
    const record = await this.#options.repository.get(id);
    const existing = record.mcp.servers[serverId];
    if (existing === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', `MCP server ${serverId} is not configured`, {
        profileId: id,
        serverId,
      });
    }
    let server: McpServerConfig;
    if (label === undefined) {
      const withoutLabel = { ...existing };
      Reflect.deleteProperty(withoutLabel, 'label');
      server = withoutLabel;
    } else {
      const parsedLabel = mcpServerLabelSchema.safeParse(label);
      if (!parsedLabel.success) {
        throw new PlinthwayError('CONFIG_INVALID', 'MCP server label is invalid', {
          issues: parsedLabel.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      server = { ...existing, label: parsedLabel.data };
    }
    await this.#options.repository.updateMcp(id, {
      ...record.mcp,
      servers: { ...record.mcp.servers, [serverId]: server },
      enabled: [...record.mcp.enabled],
      roots: [...record.mcp.roots],
    });
  }

  async setMcpServerEnabled(id: string, serverId: string, enabled: boolean): Promise<void> {
    const record = await this.#options.repository.get(id);
    if (record.mcp.servers[serverId] === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', `MCP server ${serverId} is not configured`, {
        profileId: id,
        serverId,
      });
    }
    const current = new Set(record.mcp.enabled);
    if (enabled) current.add(serverId);
    else current.delete(serverId);
    const enabledServers = [...current];
    const mcp: ProfileMcp = {
      ...record.mcp,
      servers: { ...record.mcp.servers },
      enabled: enabledServers,
      roots: [...record.mcp.roots],
    };
    const profile: WorkProfile = {
      ...record.profile,
      mcp: { enabled: enabledServers },
    };
    const result = await this.#validateRecord({ ...record, mcp, profile });
    if (!result.valid) throwInvalid(result);

    await this.#options.repository.updateMcp(id, mcp);
    try {
      await this.#options.repository.update(id, profile);
    } catch (error) {
      await this.#options.repository.updateMcp(id, record.mcp);
      throw error;
    }
  }

  async removeMcpServer(id: string, serverId: string): Promise<void> {
    const record = await this.#options.repository.get(id);
    if (record.mcp.servers[serverId] === undefined) {
      throw new PlinthwayError('CONFIG_INVALID', `MCP server ${serverId} is not configured`, {
        profileId: id,
        serverId,
      });
    }
    const servers = { ...record.mcp.servers };
    Reflect.deleteProperty(servers, serverId);
    const enabledServers = record.mcp.enabled.filter((id) => id !== serverId);
    const mcp: ProfileMcp = {
      ...record.mcp,
      servers,
      enabled: enabledServers,
      roots: [...record.mcp.roots],
    };
    const namespace = `${serverId}.`;
    const profile: WorkProfile = {
      ...record.profile,
      mcp: { enabled: enabledServers },
      tools: {
        ...record.profile.tools,
        rules: record.profile.tools.rules.filter((rule) => !rule.tool.startsWith(namespace)),
      },
    };
    const result = await this.#validateRecord({ ...record, mcp, profile });
    if (!result.valid) throwInvalid(result);

    await this.#options.repository.updateMcp(id, mcp);
    try {
      await this.#options.repository.update(id, profile);
    } catch (error) {
      await this.#options.repository.updateMcp(id, record.mcp);
      throw error;
    }
  }

  async validate(profile: WorkProfile): Promise<ProfileValidationResult> {
    const parsed = workProfileSchema.safeParse(profile);
    if (!parsed.success) return { valid: false, issues: schemaIssues(parsed.error) };
    try {
      const record = await this.#options.repository.get(parsed.data.id);
      return await this.#validateRecord({ ...record, profile: parsed.data });
    } catch (error) {
      if (!(error instanceof PlinthwayError) || error.code !== 'PROFILE_NOT_FOUND') throw error;
    }
    return this.#validateRecord({
      profile: parsed.data,
      sourcePath: this.#options.repository.pathFor(parsed.data.id),
    });
  }

  async create(profile: WorkProfile): Promise<void> {
    const parsed = workProfileSchema.safeParse(profile);
    if (!parsed.success) throwInvalid({ valid: false, issues: schemaIssues(parsed.error) });
    const result = await this.validate(parsed.data);
    if (!result.valid) throwInvalid(result);
    const bundle: ProfileBundle = {
      profile: parsed.data,
      providers: {
        schemaVersion: 1,
        providers: Object.fromEntries(
          Object.entries(this.#options.config.providers).map(([id, provider]) => [
            id,
            {
              adapter: provider.adapter,
              ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
              auth:
                provider.authPlugin === 'none'
                  ? { mode: 'none' as const }
                  : { mode: 'api-key' as const, credential: 'keyring' as const },
              models: provider.models,
            },
          ]),
        ),
      },
      mcp: {
        schemaVersion: 2,
        servers: this.#options.config.mcpServers,
        enabled: [...(parsed.data.mcp?.enabled ?? [])],
        roots: [],
      },
    };
    await this.#options.repository.create(bundle);
  }

  async update(id: string, profile: WorkProfile): Promise<void> {
    if (profile.id !== id) {
      throw new PlinthwayError('PROFILE_INVALID', 'Updated profile ID cannot change', {
        profileId: id,
      });
    }
    const parsed = workProfileSchema.safeParse(profile);
    if (!parsed.success) throwInvalid({ valid: false, issues: schemaIssues(parsed.error) });
    const record = await this.#options.repository.get(id);
    const result = await this.#validateRecord({ ...record, profile: parsed.data });
    if (!result.valid) throwInvalid(result);
    await this.#options.repository.update(id, parsed.data);
  }

  async delete(id: string): Promise<void> {
    const active = await this.#options.activeStore.get();
    if (active?.id === id) {
      throw new PlinthwayError(
        'PROFILE_ACTIVE',
        `Profile ${id} is active and must be deactivated`,
        {
          profileId: id,
        },
      );
    }
    await this.#options.repository.delete(id);
  }

  async resolve(id: string, overrides: RuntimeOverrides = {}): Promise<EffectiveProfile> {
    let parsedOverrides: RuntimeOverrides;
    try {
      parsedOverrides = runtimeOverridesSchema.parse(overrides);
    } catch (error) {
      throw new PlinthwayError(
        'PROFILE_INVALID',
        'Session overrides are invalid',
        {},
        { cause: error },
      );
    }
    const record = await this.#options.repository.get(id);
    const primary = parsedOverrides.model ?? record.profile.model.primary;
    if (primary === undefined) {
      throw new PlinthwayError('MODEL_NOT_CONFIGURED', `Profile ${id} has no primary model`, {
        profileId: id,
      });
    }
    const effectiveSource: WorkProfile = {
      ...record.profile,
      model: {
        ...record.profile.model,
        primary,
      },
      agent: {
        ...record.profile.agent,
        maxSteps: parsedOverrides.maxSteps ?? record.profile.agent.maxSteps,
        ...((parsedOverrides.toolTimeoutSeconds ?? record.profile.agent.toolTimeoutSeconds) ===
        undefined
          ? {}
          : {
              toolTimeoutSeconds:
                parsedOverrides.toolTimeoutSeconds ?? record.profile.agent.toolTimeoutSeconds,
            }),
      },
      session: { persist: parsedOverrides.persist ?? record.profile.session.persist },
    };
    const environment = {
      ...this.#options.environment,
      ...(parsedOverrides.workspace === undefined ? {} : { WORKSPACE: parsedOverrides.workspace }),
    };
    const validation = await this.#validateRecord(
      { ...record, profile: effectiveSource },
      environment,
    );
    if (!validation.valid) throwInvalid(validation);
    return resolveSnapshot({
      profile: effectiveSource,
      config: this.#options.config,
      overrides: parsedOverrides,
      environment: this.#options.environment,
      providers: record.providers,
      mcp: record.mcp,
      ...(validation.instructions === undefined ? {} : { instructions: validation.instructions }),
    });
  }

  async resolveMcp(id: string) {
    const record = await this.#options.repository.get(id);
    return resolveMcpProfile({
      profile: record.profile,
      config: this.#options.config,
      environment: this.#options.environment,
      mcp: record.mcp,
    });
  }

  async exportSanitized(id: string): Promise<SanitizedProfileExport> {
    const record = await this.#options.repository.get(id);
    const validation = await this.#validateRecord(record);
    if (!validation.valid) throwInvalid(validation);
    return sanitizeProfileExport(record, validation.instructions);
  }
}

export type { ProfileId } from '@plinthway/shared';
