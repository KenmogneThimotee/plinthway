import { describe, expect, it } from 'vitest';

import { expandPublicEnvironment } from './environment.js';

describe('expandPublicEnvironment', () => {
  it.each([
    ['${MISSING}', {}, 'CONFIG_ENV_MISSING'],
    ['${OPENAI_API_KEY}', { OPENAI_API_KEY: 'secret' }, 'CONFIG_SECRET_INTERPOLATION'],
    ['${A:-${B}}', { B: 'x' }, 'CONFIG_ENV_SYNTAX'],
  ])('rejects unsafe interpolation %s', async (value, env, code) => {
    await expect(expandPublicEnvironment(value, env)).rejects.toMatchObject({ code });
  });

  it('expands public variables exactly once and preserves Windows backslashes', async () => {
    await expect(
      expandPublicEnvironment('${WORKSPACE}\\src:${PUBLIC_URL}', {
        WORKSPACE: 'C:\\work\\demo',
        PUBLIC_URL: '${SECOND_PASS}',
        SECOND_PASS: 'must-not-expand',
      }),
    ).resolves.toBe('C:\\work\\demo\\src:${SECOND_PASS}');
  });

  it.each([
    ['bad\0value', 'CONFIG_ENV_SYNTAX'],
    ['https://user:password@example.com/path', 'CONFIG_SECRET_INTERPOLATION'],
    ['https://example.com/path?token=secret', 'CONFIG_SECRET_INTERPOLATION'],
  ])('rejects unsafe expanded output', async (value, code) => {
    await expect(expandPublicEnvironment(value, {})).rejects.toMatchObject({ code });
  });

  it('rejects expanded output larger than 32 KiB', async () => {
    await expect(
      expandPublicEnvironment('${PUBLIC_VALUE}', { PUBLIC_VALUE: 'x'.repeat(32_769) }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
