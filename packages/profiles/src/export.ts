import path from 'node:path';

import { redact } from '@plinthway/shared';
import { stringify } from 'yaml';

import type { ProfileRecord } from './repository.js';
import type { ResolvedInstructions } from './validator.js';

export interface SanitizedProfileExport {
  readonly profileYaml: string;
  readonly providersYaml: string;
  readonly mcpYaml: string;
  readonly instructions?: {
    readonly fileName: string;
    readonly content: string;
  };
}

export function sanitizeProfileExport(
  record: ProfileRecord,
  instructions?: ResolvedInstructions,
): SanitizedProfileExport {
  const profileYaml = redact(record.sourceYaml);
  const providersYaml = redact(
    stringify({
      ...record.providers,
      providers: Object.fromEntries(
        Object.entries(record.providers.providers).map(([providerId, provider]) => [
          providerId,
          provider.auth.mode === 'oauth'
            ? {
                ...provider,
                auth: { ...provider.auth, connectionId: 'local-selection-required' },
              }
            : provider,
        ]),
      ),
    }),
  );
  const mcpYaml = redact(record.mcpYaml);
  const content = instructions === undefined ? undefined : redact(instructions.content);
  if (
    typeof profileYaml !== 'string' ||
    typeof providersYaml !== 'string' ||
    typeof mcpYaml !== 'string' ||
    (content !== undefined && typeof content !== 'string')
  ) {
    throw new TypeError('Profile export redaction returned an invalid value');
  }
  return {
    profileYaml,
    providersYaml,
    mcpYaml,
    ...(instructions === undefined || content === undefined
      ? {}
      : { instructions: { fileName: path.basename(instructions.sourcePath), content } }),
  };
}
