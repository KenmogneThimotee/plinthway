import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadManagedAuthorizationConfig,
  managedAuthorizationConfigSchema,
  resolveLegacyManagedAuthorizationPath,
  resolveManagedAuthorizationPath,
} from './managed-auth.js';

const valid = {
  schemaVersion: 1,
  profiles: {
    workforce: {
      issuer: 'https://login.example.com',
      clientId: 'plinthway-desktop',
      clientCredential: { source: 'keyring', id: 'workforce-oidc-secret' },
      scopes: ['openid', 'profile'],
      resources: [
        {
          resource: 'https://mcp.example.com/api',
          authorizationServer: 'https://auth.example.com',
          clientId: 'plinthway-mcp',
          credential: { source: 'keyring', id: 'workforce-mcp-secret' },
        },
      ],
    },
  },
} as const;

describe('managed enterprise authorization configuration', () => {
  it('strictly validates issuer-bound resource registrations without secret material', () => {
    expect(managedAuthorizationConfigSchema.parse(valid)).toMatchObject(valid);
    expect(() =>
      managedAuthorizationConfigSchema.parse({
        ...valid,
        profiles: {
          workforce: {
            ...valid.profiles.workforce,
            clientSecret: 'must-not-be-in-the-file',
          },
        },
      }),
    ).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'loads a locked file and rejects group/world-writable POSIX files',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-managed-auth-'));
      const file = path.join(directory, 'managed-auth.yaml');
      await writeFile(
        file,
        `schemaVersion: 1\nprofiles:\n  workforce:\n    issuer: https://login.example.com\n    clientId: plinthway-desktop\n    scopes: [openid]\n    resources:\n      - resource: https://mcp.example.com/api\n        authorizationServer: https://auth.example.com\n        clientId: plinthway-mcp\n        credential: { source: keyring, id: workforce-mcp-secret }\n`,
        { mode: 0o600 },
      );

      await expect(
        loadManagedAuthorizationConfig({ path: file, platform: 'linux' }),
      ).resolves.toMatchObject({ profiles: { workforce: { clientId: 'plinthway-desktop' } } });
      await chmod(file, 0o666);
      await expect(
        loadManagedAuthorizationConfig({ path: file, platform: 'linux' }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    },
  );

  it('reads the legacy administrator path only when the Plinthway path is absent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-managed-auth-fallback-'));
    const current = path.join(directory, 'plinthway.yaml');
    const legacy = path.join(directory, 'harness.yaml');
    await writeFile(legacy, `schemaVersion: 1\nprofiles: {}\n`, { mode: 0o600 });

    await expect(
      loadManagedAuthorizationConfig({
        path: current,
        fallbackPath: legacy,
        platform: process.platform,
      }),
    ).resolves.toEqual({ schemaVersion: 1, profiles: {} });

    await writeFile(current, `schemaVersion: 1\nprofiles: {}\n`, { mode: 0o600 });
    await chmod(legacy, 0o666);
    await expect(
      loadManagedAuthorizationConfig({
        path: current,
        fallbackPath: legacy,
        platform: process.platform,
      }),
    ).resolves.toEqual({ schemaVersion: 1, profiles: {} });
  });

  it('uses an administrator-owned path that user environment cannot override', () => {
    expect(resolveManagedAuthorizationPath('linux', {})).toBe('/etc/plinthway/managed-auth.yaml');
    expect(resolveManagedAuthorizationPath('win32', { PROGRAMDATA: 'C:\\ProgramData' })).toBe(
      'C:\\ProgramData\\Plinthway\\managed-auth.yaml',
    );
    expect(resolveManagedAuthorizationPath('win32', { PROGRAMDATA: 'D:\\UserControlled' })).toBe(
      'C:\\ProgramData\\Plinthway\\managed-auth.yaml',
    );
    expect(
      resolveManagedAuthorizationPath('darwin', {
        PLINTHWAY_MANAGED_AUTH_CONFIG: '/user-controlled/auth.yaml',
      }),
    ).toBe('/Library/Application Support/Plinthway/managed-auth.yaml');
    expect(resolveLegacyManagedAuthorizationPath('linux')).toBe('/etc/harness/managed-auth.yaml');
    expect(resolveLegacyManagedAuthorizationPath('win32')).toBe(
      'C:\\ProgramData\\Harness\\managed-auth.yaml',
    );
  });
});
