import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { expandPublicEnvironment, type GlobalConfig } from '@plinthway/config';
import type { ModelMetadata } from '@plinthway/model-registry';
import { PlinthwayError, type WorkProfile } from '@plinthway/shared';

const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const BUILTIN_TOOL_SERVERS = new Set(['builtin', 'filesystem', 'shell']);

export type ProfileValidationIssueCode =
  | 'provider-not-found'
  | 'model-not-found'
  | 'mcp-not-found'
  | 'tool-server-disabled'
  | 'instructions-invalid';

export interface ProfileValidationIssue {
  readonly code: ProfileValidationIssueCode | 'schema-invalid';
  readonly path: string;
  readonly message: string;
}

export interface ProfileValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProfileValidationIssue[];
}

export interface ResolvedInstructions {
  readonly sourcePath: string;
  readonly content: string;
}

export interface DetailedValidationResult extends ProfileValidationResult {
  readonly instructions?: ResolvedInstructions;
}

export interface ModelRegistryLookup {
  readonly get: (id: string) => Promise<ModelMetadata>;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function resolveInstructions(
  profile: WorkProfile,
  sourcePath: string,
  roots: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedInstructions | undefined> {
  if (profile.agent.instructionsFile === undefined) return undefined;
  const expanded = await expandPublicEnvironment(profile.agent.instructionsFile, environment);
  const candidate = path.resolve(path.dirname(sourcePath), expanded);
  const [target, ...resolvedRoots] = await Promise.all([
    realpath(candidate),
    ...roots.map(async (root) => realpath(root)),
  ]);
  if (!resolvedRoots.some((root) => isInside(root, target))) {
    throw new Error('instruction path is outside configured roots');
  }
  const metadata = await stat(target);
  if (!metadata.isFile()) throw new Error('instruction path is not a file');
  if (metadata.size > MAX_INSTRUCTIONS_BYTES) throw new Error('instruction file exceeds 1 MiB');
  const content = await readFile(target, 'utf8');
  if (Buffer.byteLength(content) > MAX_INSTRUCTIONS_BYTES) {
    throw new Error('instruction file exceeds 1 MiB');
  }
  return { sourcePath: target, content };
}

export interface ValidateProfileOptions {
  readonly profile: WorkProfile;
  readonly sourcePath: string;
  readonly config: GlobalConfig;
  readonly registry: ModelRegistryLookup;
  readonly instructionRoots: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly providers?: Readonly<Record<string, unknown>>;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
}

export async function validateProfile(
  options: ValidateProfileOptions,
): Promise<DetailedValidationResult> {
  const issues: ProfileValidationIssue[] = [];
  const models = [
    ...(options.profile.model.primary === undefined ? [] : [options.profile.model.primary]),
    ...options.profile.model.fallback,
  ];
  for (const [index, model] of models.entries()) {
    const providerId = model.split('/')[0] ?? '';
    const modelPath = index === 0 ? 'model.primary' : `model.fallback.${String(index - 1)}`;
    const providers = options.providers ?? options.config.providers;
    if (providers[providerId] === undefined) {
      issues.push({
        code: 'provider-not-found',
        path: modelPath,
        message: `Provider ${providerId} is not configured`,
      });
      continue;
    }
    try {
      await options.registry.get(model);
    } catch (error) {
      if (!(error instanceof PlinthwayError) || error.code !== 'MODEL_NOT_FOUND') throw error;
      issues.push({
        code: 'model-not-found',
        path: modelPath,
        message: `Model ${model} was not found`,
      });
    }
  }

  const enabledServers = options.profile.mcp?.enabled ?? [];
  const enabled = new Set(enabledServers);
  const mcpServers = options.mcpServers ?? options.config.mcpServers;
  for (const [index, serverId] of enabledServers.entries()) {
    if (mcpServers[serverId] === undefined) {
      issues.push({
        code: 'mcp-not-found',
        path: `mcp.enabled.${String(index)}`,
        message: `MCP server ${serverId} is not configured`,
      });
    }
  }
  for (const [index, rule] of options.profile.tools.rules.entries()) {
    const serverId = rule.tool.split('.')[0] ?? '';
    if (
      !BUILTIN_TOOL_SERVERS.has(serverId) &&
      !enabled.has(serverId) &&
      (options.mcpServers === undefined || mcpServers[serverId] === undefined)
    ) {
      issues.push({
        code: 'tool-server-disabled',
        path: `tools.rules.${String(index)}.tool`,
        message: `Tool rule ${rule.tool} targets a server that is not enabled`,
      });
    }
  }

  let instructions: ResolvedInstructions | undefined;
  try {
    instructions = await resolveInstructions(
      options.profile,
      options.sourcePath,
      options.instructionRoots,
      options.environment,
    );
  } catch {
    issues.push({
      code: 'instructions-invalid',
      path: 'agent.instructionsFile',
      message: 'Instruction file is missing, outside configured roots, unreadable, or too large',
    });
  }
  return {
    valid: issues.length === 0,
    issues,
    ...(instructions === undefined ? {} : { instructions }),
  };
}
