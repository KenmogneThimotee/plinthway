import { PlinthwayError } from '@plinthway/shared';

const ENVIRONMENT_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const SECRET_NAME = /authorization|token|secret|password|api[-_]?key|cookie/iu;
const MAX_EXPANDED_BYTES = 32 * 1024;

function syntaxError(message: string): PlinthwayError {
  return new PlinthwayError('CONFIG_ENV_SYNTAX', message);
}

function assertSafeOutput(value: string): void {
  if (value.includes('\0')) {
    throw syntaxError('Environment expansion produced a NUL byte');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_EXPANDED_BYTES) {
    throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'Environment expansion exceeds 32 KiB');
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw syntaxError('Environment expansion produced an invalid URL');
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new PlinthwayError(
        'CONFIG_SECRET_INTERPOLATION',
        'Credentials are not allowed in URL userinfo',
      );
    }
    for (const key of url.searchParams.keys()) {
      if (SECRET_NAME.test(key)) {
        throw new PlinthwayError(
          'CONFIG_SECRET_INTERPOLATION',
          'Credentials are not allowed in URL query parameters',
        );
      }
    }
  }
}

export async function expandPublicEnvironment(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  await Promise.resolve();
  if (value.includes('\0')) {
    throw syntaxError('Configuration values cannot contain NUL bytes');
  }

  let cursor = 0;
  let expanded = '';
  for (const match of value.matchAll(ENVIRONMENT_TOKEN)) {
    const index = match.index;
    const prefix = value.slice(cursor, index);
    if (prefix.includes('${') || prefix.includes('}')) {
      throw syntaxError('Only simple ${NAME} environment substitutions are supported');
    }

    const name = match[1];
    if (name === undefined) {
      throw syntaxError('Invalid environment substitution');
    }
    if (SECRET_NAME.test(name)) {
      throw new PlinthwayError(
        'CONFIG_SECRET_INTERPOLATION',
        `Secret environment variable ${name} cannot be interpolated`,
      );
    }
    const replacement = env[name];
    if (replacement === undefined) {
      throw new PlinthwayError('CONFIG_ENV_MISSING', `Environment variable ${name} is not defined`);
    }
    expanded += prefix + replacement;
    cursor = index + match[0].length;
  }

  const suffix = value.slice(cursor);
  if (suffix.includes('${') || suffix.includes('}')) {
    throw syntaxError('Only simple ${NAME} environment substitutions are supported');
  }
  expanded += suffix;
  assertSafeOutput(expanded);
  return expanded;
}
