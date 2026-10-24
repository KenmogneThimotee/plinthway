import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile, BUILTIN_TOOL_NAMESPACES, profileIdSchema } from '@plinthway/config';
import { asProfileId, PlinthwayError, type JsonValue, type WorkProfile } from '@plinthway/shared';
import { parseDocument, stringify } from 'yaml';
import { ZodError, type ZodType } from 'zod';

import {
  profileBundleSchema,
  profileMcpSchema,
  profileProvidersSchema,
  workProfileSchema,
  type ProfileBundle,
  type ProfileMcp,
  type ProfileProviders,
} from './schema.js';

export interface ProfileRecord extends ProfileBundle {
  readonly sourcePath: string;
  readonly sourceYaml: string;
  readonly providersPath: string;
  readonly providersYaml: string;
  readonly mcpPath: string;
  readonly mcpYaml: string;
}

export type ProfileFileWriter = (file: string, contents: string | Uint8Array) => Promise<void>;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function isProfileCreationCollision(
  error: unknown,
  destination: string,
): Promise<boolean> {
  if (hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY')) return true;
  if (!hasCode(error, 'EPERM')) return false;
  return stat(destination).then(
    () => true,
    () => false,
  );
}

function invalid(message: string, details: Record<string, JsonValue> = {}, cause?: unknown) {
  return new PlinthwayError(
    'PROFILE_INVALID',
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function serialize<T>(schema: ZodType<T>, value: T, section: string): string {
  try {
    return stringify(schema.parse(value), { lineWidth: 100 });
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalid(`${section} failed schema validation`, {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    throw invalid(`${section} could not be serialized`, {}, error);
  }
}

async function parseFile<T>(
  file: string,
  schema: ZodType<T>,
  section: string,
): Promise<{ value: T; yaml: string }> {
  const source = await readYaml(file, section);
  try {
    return { value: schema.parse(source.value), yaml: source.yaml };
  } catch (error) {
    if (error instanceof ZodError) {
      throw invalid(`${section} failed schema validation`, {
        path: file,
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    throw error;
  }
}

async function readYaml(file: string, section: string): Promise<{ value: unknown; yaml: string }> {
  let yaml: string;
  try {
    yaml = await readFile(file, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', `${section} was not found`, { path: file });
    }
    throw new PlinthwayError(
      'STORAGE_ERROR',
      `${section} could not be read`,
      { path: file },
      { cause: error },
    );
  }
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw invalid(`${section} is not valid YAML`, { path: file });
  }
  return { value: document.toJS(), yaml };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function migratedServerId(id: string, occupied: Set<string>): string {
  const base = `${id}-mcp`;
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  return candidate;
}

function isMigratedServerId(candidate: string, original: string): boolean {
  const base = `${original}-mcp`;
  if (candidate === base) return true;
  if (!candidate.startsWith(`${base}-`)) return false;
  const suffix = candidate.slice(base.length + 1);
  return /^(?:[2-9]|[1-9]\d+)$/.test(suffix);
}

function migrateReservedMcpIds(
  profileValue: unknown,
  mcpValue: unknown,
): { readonly profile: unknown; readonly mcp: unknown } | undefined {
  const profile = objectValue(profileValue);
  const mcp = objectValue(mcpValue);
  const servers = objectValue(mcp?.servers);
  if (profile === undefined || mcp === undefined || servers === undefined) return undefined;

  const profileMcp = objectValue(profile.mcp);
  const profileEnabled = Array.isArray(profileMcp?.enabled) ? profileMcp.enabled : [];
  const mcpEnabled = Array.isArray(mcp.enabled) ? mcp.enabled : [];
  const occupied = new Set(Object.keys(servers));
  const replacements = new Map<string, string>();
  for (const id of BUILTIN_TOOL_NAMESPACES) {
    if (id in servers) {
      occupied.delete(id);
      const replacement = migratedServerId(id, occupied);
      replacements.set(id, replacement);
      occupied.add(replacement);
      continue;
    }

    if (!profileEnabled.includes(id)) continue;
    const migratedCandidates = [
      ...new Set(
        mcpEnabled.filter(
          (candidate): candidate is string =>
            typeof candidate === 'string' &&
            candidate in servers &&
            isMigratedServerId(candidate, id),
        ),
      ),
    ];
    const migratedCandidate = migratedCandidates.length === 1 ? migratedCandidates[0] : undefined;
    if (migratedCandidate !== undefined) replacements.set(id, migratedCandidate);
  }
  if (replacements.size === 0) return undefined;

  const renameId = (value: unknown): unknown =>
    typeof value === 'string' ? (replacements.get(value) ?? value) : value;
  const renameEnabled = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const seen = new Set<string>();
    return value.flatMap((entry) => {
      const renamed = renameId(entry);
      if (typeof renamed !== 'string') return [renamed];
      if (seen.has(renamed)) return [];
      seen.add(renamed);
      return [renamed];
    });
  };
  const migratedServers = Object.fromEntries(
    Object.entries(servers).map(([id, server]) => [replacements.get(id) ?? id, server]),
  );
  const tools = objectValue(profile.tools);
  const rawRules: unknown = tools?.rules;
  const rules = Array.isArray(rawRules)
    ? rawRules.map((ruleValue: unknown) => {
        const rule = objectValue(ruleValue);
        if (rule === undefined || typeof rule.tool !== 'string') return ruleValue;
        for (const [id, replacement] of replacements) {
          if (rule.tool.startsWith(`${id}.`)) {
            return { ...rule, tool: `${replacement}${rule.tool.slice(id.length)}` };
          }
        }
        return ruleValue;
      })
    : rawRules;

  return {
    profile: {
      ...profile,
      ...(profileMcp === undefined
        ? {}
        : { mcp: { ...profileMcp, enabled: renameEnabled(profileMcp.enabled) } }),
      ...(tools === undefined ? {} : { tools: { ...tools, rules } }),
    },
    mcp: {
      ...mcp,
      servers: migratedServers,
      enabled: renameEnabled(mcp.enabled),
    },
  };
}

export function emptyDefaultProfile(): ProfileBundle {
  return profileBundleSchema.parse({
    profile: {
      schemaVersion: 1,
      id: asProfileId('default'),
      name: 'Default',
      model: { fallback: [], parameters: {} },
      tools: { defaultPolicy: 'deny', rules: [] },
      agent: { maxSteps: 12, toolTimeoutSeconds: 30 },
      session: { persist: true },
    },
    providers: { schemaVersion: 1, providers: {} },
    mcp: { schemaVersion: 1, servers: {}, enabled: [] },
  });
}

function asBundle(value: WorkProfile | ProfileBundle): ProfileBundle {
  if ('profile' in value) return profileBundleSchema.parse(value);
  return profileBundleSchema.parse({
    profile: value,
    providers: { schemaVersion: 1, providers: {} },
    mcp: { schemaVersion: 1, servers: {}, enabled: value.mcp?.enabled ?? [] },
  });
}

export class FileProfileRepository {
  readonly #directory: string;
  readonly #write: ProfileFileWriter;
  #reservedIdMigration: Promise<void> | undefined;

  constructor(directory: string, writer: ProfileFileWriter = atomicWriteFile) {
    this.#directory = path.resolve(directory);
    this.#write = writer;
  }

  directoryFor(id: string): string {
    const parsed = profileIdSchema.safeParse(id);
    if (!parsed.success) throw invalid('Profile ID is invalid', { profileId: id });
    return path.join(this.#directory, parsed.data);
  }

  pathFor(id: string): string {
    return path.join(this.directoryFor(id), 'profile.yaml');
  }

  async get(id: string): Promise<ProfileRecord> {
    const directory = this.directoryFor(id);
    const sourcePath = path.join(directory, 'profile.yaml');
    const providersPath = path.join(directory, 'providers.yaml');
    const mcpPath = path.join(directory, 'mcp.yaml');
    const profile = await parseFile(sourcePath, workProfileSchema, `Profile ${id}`);
    if (profile.value.id !== id) {
      throw invalid('Profile ID does not match its directory', { profileId: id });
    }
    const providers = await parseFile(
      providersPath,
      profileProvidersSchema,
      `Providers for profile ${id}`,
    );
    const mcp = await parseFile(mcpPath, profileMcpSchema, `MCP configuration for profile ${id}`);
    return {
      profile: profile.value,
      providers: providers.value,
      mcp: mcp.value,
      sourcePath,
      sourceYaml: profile.yaml,
      providersPath,
      providersYaml: providers.yaml,
      mcpPath,
      mcpYaml: mcp.yaml,
    };
  }

  async list(): Promise<readonly ProfileRecord[]> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw new PlinthwayError(
        'STORAGE_ERROR',
        'Profile directory could not be read',
        {},
        { cause: error },
      );
    }
    const ids = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(ids.map(async (id) => this.get(id)));
  }

  async create(value: WorkProfile | ProfileBundle): Promise<void> {
    const bundle = asBundle(value);
    const destination = this.directoryFor(bundle.profile.id);
    const staging = `${destination}.creating-${randomUUID()}`;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      await Promise.all([
        atomicWriteFile(
          path.join(staging, 'profile.yaml'),
          serialize(workProfileSchema, bundle.profile, 'Profile'),
        ),
        atomicWriteFile(
          path.join(staging, 'providers.yaml'),
          serialize(profileProvidersSchema, bundle.providers, 'Providers'),
        ),
        atomicWriteFile(
          path.join(staging, 'mcp.yaml'),
          serialize(profileMcpSchema, bundle.mcp, 'MCP configuration'),
        ),
      ]);
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (await isProfileCreationCollision(error, destination)) {
        throw invalid(`Profile ${bundle.profile.id} already exists`, {
          profileId: bundle.profile.id,
        });
      }
      if (error instanceof PlinthwayError) throw error;
      throw new PlinthwayError(
        'STORAGE_ERROR',
        `Profile ${bundle.profile.id} could not be created`,
        { profileId: bundle.profile.id },
        { cause: error },
      );
    }
  }

  async ensureDefaultIfEmpty(): Promise<ProfileBundle> {
    this.#reservedIdMigration ??= this.#migrateReservedMcpServerIds();
    await this.#reservedIdMigration;
    const existing = await this.list();
    if (existing.length > 0) {
      const selected = existing.find((record) => record.profile.id === 'default') ?? existing[0];
      if (selected === undefined)
        throw new PlinthwayError('STORAGE_ERROR', 'Profile list changed during initialization');
      return { profile: selected.profile, providers: selected.providers, mcp: selected.mcp };
    }
    const bundle = emptyDefaultProfile();
    try {
      await this.create(bundle);
      return bundle;
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'PROFILE_INVALID') {
        const raced = await this.list();
        const selected = raced.find((record) => record.profile.id === 'default') ?? raced[0];
        if (selected !== undefined) {
          return { profile: selected.profile, providers: selected.providers, mcp: selected.mcp };
        }
      }
      throw error;
    }
  }

  async #migrateReservedMcpServerIds(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.#directory, entry.name);
      const profilePath = path.join(directory, 'profile.yaml');
      const mcpPath = path.join(directory, 'mcp.yaml');
      const [profileSource, mcpSource] = await Promise.all([
        readYaml(profilePath, `Profile ${entry.name}`),
        readYaml(mcpPath, `MCP configuration for profile ${entry.name}`),
      ]);
      const migrated = migrateReservedMcpIds(profileSource.value, mcpSource.value);
      if (migrated === undefined) continue;
      const nextProfile = serialize(workProfileSchema, migrated.profile, `Profile ${entry.name}`);
      const nextMcp = serialize(
        profileMcpSchema,
        migrated.mcp,
        `MCP configuration for profile ${entry.name}`,
      );
      await this.#write(profilePath, nextProfile);
      try {
        await this.#write(mcpPath, nextMcp);
      } catch (error) {
        try {
          await this.#write(profilePath, profileSource.yaml);
        } catch (rollbackError) {
          throw new PlinthwayError(
            'STORAGE_ERROR',
            `Profile ${entry.name} MCP namespace migration could not be restored`,
            { profileId: entry.name },
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        throw error;
      }
    }
  }

  async update(id: string, profile: WorkProfile): Promise<void> {
    if (profile.id !== id) {
      throw invalid('Updated profile ID cannot change', { profileId: id });
    }
    await this.get(id);
    await atomicWriteFile(this.pathFor(id), serialize(workProfileSchema, profile, 'Profile'));
  }

  async updateProviders(id: string, providers: ProfileProviders): Promise<void> {
    await this.get(id);
    await atomicWriteFile(
      path.join(this.directoryFor(id), 'providers.yaml'),
      serialize(profileProvidersSchema, providers, 'Providers'),
    );
  }

  async updateProviderSelection(
    id: string,
    providers: ProfileProviders,
    profile: WorkProfile,
  ): Promise<void> {
    if (profile.id !== id) {
      throw invalid('Updated profile ID cannot change', { profileId: id });
    }
    const record = await this.get(id);
    const nextProviders = serialize(profileProvidersSchema, providers, 'Providers');
    const nextProfile = serialize(workProfileSchema, profile, 'Profile');
    await this.#write(record.providersPath, nextProviders);
    try {
      await this.#write(record.sourcePath, nextProfile);
    } catch (error) {
      try {
        await this.#write(record.providersPath, record.providersYaml);
      } catch (rollbackError) {
        throw new PlinthwayError(
          'STORAGE_ERROR',
          `Profile ${id} provider selection could not be restored`,
          { profileId: id },
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw error;
    }
  }

  async updateMcp(id: string, mcp: ProfileMcp): Promise<void> {
    await this.get(id);
    await atomicWriteFile(
      path.join(this.directoryFor(id), 'mcp.yaml'),
      serialize(profileMcpSchema, mcp, 'MCP configuration'),
    );
  }

  async delete(id: string): Promise<void> {
    try {
      await rm(this.directoryFor(id), { recursive: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        throw new PlinthwayError('PROFILE_NOT_FOUND', `Profile ${id} was not found`, {
          profileId: id,
        });
      }
      throw new PlinthwayError(
        'STORAGE_ERROR',
        `Profile ${id} could not be deleted`,
        { profileId: id },
        { cause: error },
      );
    }
  }
}
