import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { deepFreeze, PlinthwayError } from '@plinthway/shared';
import { parseDocument } from 'yaml';
import { z, ZodError } from 'zod';

import { secureUrlSchema } from './schema.js';

const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const keyringReferenceSchema = z.strictObject({
  source: z.literal('keyring'),
  id: z.string().min(1).max(200),
});

export const managedAuthorizationResourceSchema = z.strictObject({
  resource: secureUrlSchema,
  authorizationServer: secureUrlSchema,
  clientId: z.string().min(1),
  credential: keyringReferenceSchema,
  scopes: z.array(z.string().min(1)).default([]),
});

export const managedAuthorizationProfileSchema = z
  .strictObject({
    issuer: secureUrlSchema,
    clientId: z.string().min(1),
    clientCredential: keyringReferenceSchema.optional(),
    scopes: z.array(z.string().min(1)).default(['openid']),
    resources: z.array(managedAuthorizationResourceSchema).min(1),
  })
  .superRefine((value, context) => {
    if (!value.scopes.includes('openid')) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Enterprise OIDC scopes must include openid',
      });
    }
    const resources = new Set<string>();
    for (const [index, registration] of value.resources.entries()) {
      const resource = new URL(registration.resource).href;
      if (resources.has(resource)) {
        context.addIssue({
          code: 'custom',
          path: ['resources', index, 'resource'],
          message: 'Managed resource registrations must be unique',
        });
      }
      resources.add(resource);
    }
  });

export const managedAuthorizationConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z.record(identifierSchema, managedAuthorizationProfileSchema).default({}),
});

export type ManagedAuthorizationConfig = z.infer<typeof managedAuthorizationConfigSchema>;
export type ManagedAuthorizationProfile = z.infer<typeof managedAuthorizationProfileSchema>;
export type ManagedAuthorizationResource = z.infer<typeof managedAuthorizationResourceSchema>;

export function resolveManagedAuthorizationPath(
  platform: NodeJS.Platform,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- managed policy paths must not honor user-controlled environment overrides
  _env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    return path.win32.join('C:\\ProgramData', 'Plinthway', 'managed-auth.yaml');
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/Plinthway/managed-auth.yaml';
  }
  return '/etc/plinthway/managed-auth.yaml';
}

/** Resolves the historical administrator-owned location for read-only fallback. */
export function resolveLegacyManagedAuthorizationPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.win32.join('C:\\ProgramData', 'Harness', 'managed-auth.yaml');
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/Harness/managed-auth.yaml';
  }
  return '/etc/harness/managed-auth.yaml';
}

export interface LoadManagedAuthorizationConfigOptions {
  readonly path: string;
  readonly fallbackPath?: string;
  readonly platform?: NodeJS.Platform;
}

function invalidManagedConfig(error: unknown, configPath: string): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  if (error instanceof ZodError) {
    return new PlinthwayError(
      'CONFIG_INVALID',
      'Managed authorization configuration failed validation',
      {
        path: configPath,
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
  }
  return new PlinthwayError(
    'CONFIG_INVALID',
    'Managed authorization configuration could not be loaded',
    { path: configPath },
    { cause: error },
  );
}

async function loadManagedAuthorizationConfigAtPath(
  configPath: string,
  platform: NodeJS.Platform,
): Promise<ManagedAuthorizationConfig | null> {
  try {
    let source: string;
    try {
      const [metadata, contents] = await Promise.all([
        stat(configPath),
        readFile(configPath, 'utf8'),
      ]);
      if (platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
        throw new PlinthwayError(
          'CONFIG_INVALID',
          'Managed authorization configuration must not be group- or world-writable',
          { path: configPath },
        );
      }
      source = contents;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new PlinthwayError(
        'CONFIG_INVALID',
        'Managed authorization configuration is not valid YAML',
        {
          path: configPath,
        },
      );
    }
    return deepFreeze(managedAuthorizationConfigSchema.parse(document.toJS()));
  } catch (error) {
    throw invalidManagedConfig(error, configPath);
  }
}

export async function loadManagedAuthorizationConfig(
  options: LoadManagedAuthorizationConfigOptions,
): Promise<ManagedAuthorizationConfig> {
  const platform = options.platform ?? process.platform;
  const current = await loadManagedAuthorizationConfigAtPath(options.path, platform);
  if (current !== null) return current;
  if (options.fallbackPath !== undefined) {
    const fallback = await loadManagedAuthorizationConfigAtPath(options.fallbackPath, platform);
    if (fallback !== null) return fallback;
  }
  return deepFreeze({ schemaVersion: 1, profiles: {} });
}
