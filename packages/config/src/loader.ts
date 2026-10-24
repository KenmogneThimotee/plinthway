import { readFile } from 'node:fs/promises';

import { deepFreeze, PlinthwayError } from '@plinthway/shared';
import { parseDocument } from 'yaml';
import { ZodError } from 'zod';

import { expandPublicEnvironment } from './environment.js';
import {
  DEFAULT_GLOBAL_CONFIG,
  globalConfigSchema,
  runtimeOverridesSchema,
  type GlobalConfig,
  type RuntimeOverrides,
} from './schema.js';

type UnknownRecord = Record<string, unknown>;

export interface LoadGlobalConfigOptions {
  readonly configPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly workspace?: string;
  readonly overrides?: RuntimeOverrides;
}

export interface LoadedGlobalConfig {
  readonly config: GlobalConfig;
  readonly runtime: RuntimeOverrides;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }

  const result: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

async function expandValue(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  if (typeof value === 'string') {
    return expandPublicEnvironment(value, env);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(async (entry) => expandValue(entry, env)));
  }
  if (isRecord(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, entry]) => [key, await expandValue(entry, env)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

async function readYamlFile(configPath: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw new PlinthwayError(
      'CONFIG_INVALID',
      'Could not read global configuration',
      { path: configPath },
      { cause: error },
    );
  }

  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new PlinthwayError('CONFIG_INVALID', 'Global configuration is not valid YAML', {
      path: configPath,
    });
  }
  return document.toJS() ?? {};
}

function invalidConfig(error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) {
    return error;
  }
  if (error instanceof ZodError) {
    return new PlinthwayError('CONFIG_INVALID', 'Global configuration failed validation', {
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return new PlinthwayError(
    'CONFIG_INVALID',
    'Global configuration could not be loaded',
    {},
    {
      cause: error,
    },
  );
}

export async function loadGlobalConfig(
  options: LoadGlobalConfigOptions = {},
): Promise<LoadedGlobalConfig> {
  try {
    const runtime = runtimeOverridesSchema.parse(options.overrides ?? {});
    const workspace = runtime.workspace ?? options.workspace;
    const environment = {
      ...(options.env ?? {}),
      ...(workspace === undefined ? {} : { WORKSPACE: workspace }),
    };
    const fileConfig =
      options.configPath === undefined ? {} : await readYamlFile(options.configPath);
    if (!isRecord(fileConfig)) {
      throw new PlinthwayError('CONFIG_INVALID', 'Global configuration must be a YAML object');
    }
    const expanded = await expandValue(fileConfig, environment);
    const config = globalConfigSchema.parse(deepMerge(DEFAULT_GLOBAL_CONFIG, expanded));
    return deepFreeze({
      config,
      runtime: { ...(workspace === undefined ? {} : { workspace }), ...runtime },
    });
  } catch (error) {
    throw invalidConfig(error);
  }
}
