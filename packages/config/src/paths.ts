import path from 'node:path';

export interface PlinthwayPaths {
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly profiles: string;
  readonly credentials: string;
  readonly database: string;
  readonly chatgptAccounts: string;
  readonly chatgptHost: string;
  readonly chatgptModelCache: string;
}

export type PlinthwayEnvironment = Readonly<Record<string, string | undefined>>;

export function resolvePlinthwayPaths(
  platform: NodeJS.Platform,
  env: PlinthwayEnvironment,
  homedir: string,
): PlinthwayPaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const explicitHome = env.PLINTHWAY_HOME;

  if (explicitHome !== undefined && explicitHome.length > 0) {
    const data = pathApi.join(explicitHome, 'data');
    return {
      config: pathApi.join(explicitHome, 'config.yaml'),
      data,
      cache: pathApi.join(explicitHome, 'cache'),
      profiles: pathApi.join(explicitHome, 'profiles'),
      credentials: pathApi.join(data, 'credentials.enc'),
      database: pathApi.join(data, 'plinthway.sqlite'),
      chatgptAccounts: pathApi.join(data, 'chatgpt-accounts.json'),
      chatgptHost: pathApi.join(data, 'chatgpt-host.json'),
      chatgptModelCache: pathApi.join(explicitHome, 'cache', 'chatgpt-models.json'),
    };
  }

  let configRoot: string;
  let dataRoot: string;
  let cacheRoot: string;

  if (platform === 'win32') {
    configRoot = env.APPDATA ?? pathApi.join(homedir, 'AppData', 'Roaming');
    dataRoot = env.LOCALAPPDATA ?? env.APPDATA ?? pathApi.join(homedir, 'AppData', 'Local');
    cacheRoot = env.LOCALAPPDATA ?? dataRoot;
  } else if (platform === 'darwin') {
    configRoot = pathApi.join(homedir, 'Library', 'Application Support');
    dataRoot = configRoot;
    cacheRoot = pathApi.join(homedir, 'Library', 'Caches');
  } else {
    configRoot = env.XDG_CONFIG_HOME ?? pathApi.join(homedir, '.config');
    dataRoot = env.XDG_DATA_HOME ?? pathApi.join(homedir, '.local', 'share');
    cacheRoot = env.XDG_CACHE_HOME ?? pathApi.join(homedir, '.cache');
  }

  const configDirectory = pathApi.join(configRoot, 'plinthway');
  const data = pathApi.join(dataRoot, 'plinthway');
  const cache = pathApi.join(cacheRoot, 'plinthway');

  return {
    config: pathApi.join(configDirectory, 'config.yaml'),
    data,
    cache,
    profiles: pathApi.join(configDirectory, 'profiles'),
    credentials: pathApi.join(data, 'credentials.enc'),
    database: pathApi.join(data, 'plinthway.sqlite'),
    chatgptAccounts: pathApi.join(data, 'chatgpt-accounts.json'),
    chatgptHost: pathApi.join(data, 'chatgpt-host.json'),
    chatgptModelCache: pathApi.join(cache, 'chatgpt-models.json'),
  };
}

/** Resolves the pre-Plinthway locations for one-time, read-only migration. */
export function resolveLegacyHarnessPaths(
  platform: NodeJS.Platform,
  env: PlinthwayEnvironment,
  homedir: string,
): PlinthwayPaths {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const explicitHome = env.HARNESS_HOME;

  if (explicitHome !== undefined && explicitHome.length > 0) {
    const data = pathApi.join(explicitHome, 'data');
    return {
      config: pathApi.join(explicitHome, 'config.yaml'),
      data,
      cache: pathApi.join(explicitHome, 'cache'),
      profiles: pathApi.join(explicitHome, 'profiles'),
      credentials: pathApi.join(data, 'credentials.enc'),
      database: pathApi.join(data, 'harness.sqlite'),
      chatgptAccounts: pathApi.join(data, 'chatgpt-accounts.json'),
      chatgptHost: pathApi.join(data, 'chatgpt-host.json'),
      chatgptModelCache: pathApi.join(explicitHome, 'cache', 'chatgpt-models.json'),
    };
  }

  let configRoot: string;
  let dataRoot: string;
  let cacheRoot: string;

  if (platform === 'win32') {
    configRoot = env.APPDATA ?? pathApi.join(homedir, 'AppData', 'Roaming');
    dataRoot = env.LOCALAPPDATA ?? env.APPDATA ?? pathApi.join(homedir, 'AppData', 'Local');
    cacheRoot = env.LOCALAPPDATA ?? dataRoot;
  } else if (platform === 'darwin') {
    configRoot = pathApi.join(homedir, 'Library', 'Application Support');
    dataRoot = configRoot;
    cacheRoot = pathApi.join(homedir, 'Library', 'Caches');
  } else {
    configRoot = env.XDG_CONFIG_HOME ?? pathApi.join(homedir, '.config');
    dataRoot = env.XDG_DATA_HOME ?? pathApi.join(homedir, '.local', 'share');
    cacheRoot = env.XDG_CACHE_HOME ?? pathApi.join(homedir, '.cache');
  }

  const configDirectory = pathApi.join(configRoot, 'harness');
  const data = pathApi.join(dataRoot, 'harness');
  const cache = pathApi.join(cacheRoot, 'harness');
  return {
    config: pathApi.join(configDirectory, 'config.yaml'),
    data,
    cache,
    profiles: pathApi.join(configDirectory, 'profiles'),
    credentials: pathApi.join(data, 'credentials.enc'),
    database: pathApi.join(data, 'harness.sqlite'),
    chatgptAccounts: pathApi.join(data, 'chatgpt-accounts.json'),
    chatgptHost: pathApi.join(data, 'chatgpt-host.json'),
    chatgptModelCache: pathApi.join(cache, 'chatgpt-models.json'),
  };
}
