import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLegacyHarnessPaths, resolvePlinthwayPaths } from './paths.js';

describe('resolvePlinthwayPaths', () => {
  it('uses XDG locations on Linux', () => {
    const paths = resolvePlinthwayPaths(
      'linux',
      {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_CACHE_HOME: '/xdg/cache',
      },
      '/home/ada',
    );

    expect(paths).toEqual({
      config: '/xdg/config/plinthway/config.yaml',
      data: '/xdg/data/plinthway',
      cache: '/xdg/cache/plinthway',
      profiles: '/xdg/config/plinthway/profiles',
      credentials: '/xdg/data/plinthway/credentials.enc',
      database: '/xdg/data/plinthway/plinthway.sqlite',
      chatgptAccounts: '/xdg/data/plinthway/chatgpt-accounts.json',
      chatgptHost: '/xdg/data/plinthway/chatgpt-host.json',
      chatgptModelCache: '/xdg/cache/plinthway/chatgpt-models.json',
    });
  });

  it('uses Application Support and Caches on macOS', () => {
    const paths = resolvePlinthwayPaths('darwin', {}, '/Users/ada');
    expect(paths.config).toBe('/Users/ada/Library/Application Support/plinthway/config.yaml');
    expect(paths.cache).toBe('/Users/ada/Library/Caches/plinthway');
  });

  it('uses APPDATA and Windows path separators on Windows', () => {
    const paths = resolvePlinthwayPaths(
      'win32',
      { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
      'C:\\Users\\Ada',
    );
    expect(paths.config).toBe(
      path.win32.join('C:\\Users\\Ada\\AppData\\Roaming', 'plinthway', 'config.yaml'),
    );
    expect(paths.database).toBe(
      path.win32.join('C:\\Users\\Ada\\AppData\\Roaming', 'plinthway', 'plinthway.sqlite'),
    );
  });

  it('places all state below explicit PLINTHWAY_HOME', () => {
    const paths = resolvePlinthwayPaths(
      'linux',
      { PLINTHWAY_HOME: '/srv/plinthway', XDG_CONFIG_HOME: '/ignored' },
      '/home/ada',
    );
    expect(paths).toEqual({
      config: '/srv/plinthway/config.yaml',
      data: '/srv/plinthway/data',
      cache: '/srv/plinthway/cache',
      profiles: '/srv/plinthway/profiles',
      credentials: '/srv/plinthway/data/credentials.enc',
      database: '/srv/plinthway/data/plinthway.sqlite',
      chatgptAccounts: '/srv/plinthway/data/chatgpt-accounts.json',
      chatgptHost: '/srv/plinthway/data/chatgpt-host.json',
      chatgptModelCache: '/srv/plinthway/cache/chatgpt-models.json',
    });
  });
});

describe('resolveLegacyHarnessPaths', () => {
  it('resolves the historical default locations and database name', () => {
    const paths = resolveLegacyHarnessPaths(
      'linux',
      {
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_DATA_HOME: '/xdg/data',
        XDG_CACHE_HOME: '/xdg/cache',
      },
      '/home/ada',
    );

    expect(paths.config).toBe('/xdg/config/harness/config.yaml');
    expect(paths.database).toBe('/xdg/data/harness/harness.sqlite');
    expect(paths.cache).toBe('/xdg/cache/harness');
  });

  it('honors only the historical HARNESS_HOME override', () => {
    const paths = resolveLegacyHarnessPaths(
      'linux',
      { HARNESS_HOME: '/srv/harness', PLINTHWAY_HOME: '/srv/plinthway' },
      '/home/ada',
    );

    expect(paths.config).toBe('/srv/harness/config.yaml');
    expect(paths.database).toBe('/srv/harness/data/harness.sqlite');
  });
});
