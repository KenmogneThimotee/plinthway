import { PlinthwayError, registerRedactionSecret } from '@plinthway/shared';

import {
  credentialSecret,
  type AuthLoginInput,
  type AuthPlugin,
  type AuthStatus,
  type Credential,
  type CredentialStore,
} from './contracts.js';
import { EncryptedFileCredentialStore } from './encrypted-file-store.js';
import { EnvironmentCredentialStore } from './environment-store.js';
import { KeyringCredentialStore } from './keyring-store.js';

const DEFAULT_ACCOUNT = 'default';

interface ApiKeyPluginOptions {
  readonly id: string;
  readonly providerId: string;
  readonly environmentVariable: string;
  readonly environment: EnvironmentCredentialStore;
  readonly keyring: CredentialStore;
  readonly encryptedFile: CredentialStore;
}

interface CredentialLookup {
  readonly credential: Credential | null;
  readonly source: AuthStatus['source'];
}

export class ApiKeyAuthPlugin implements AuthPlugin {
  readonly id: string;
  readonly providerId: string;
  readonly #environmentVariable: string;
  readonly #environment: EnvironmentCredentialStore;
  readonly #keyring: CredentialStore;
  readonly #encryptedFile: CredentialStore;

  constructor(options: ApiKeyPluginOptions) {
    this.id = options.id;
    this.providerId = options.providerId;
    this.#environmentVariable = options.environmentVariable;
    this.#environment = options.environment;
    this.#keyring = options.keyring;
    this.#encryptedFile = options.encryptedFile;
  }

  #account(account?: string): string {
    return `${this.id}:${account ?? DEFAULT_ACCOUNT}`;
  }

  async #lookup(account?: string): Promise<CredentialLookup> {
    const environmentCredential = this.#environment.getApiKey(this.#environmentVariable);
    if (environmentCredential !== null) {
      return { credential: environmentCredential, source: 'environment' };
    }

    const key = this.#account(account);
    try {
      const credential = await this.#keyring.get(key);
      if (credential !== null) return { credential, source: 'keyring' };
    } catch {
      // An unavailable or locked keyring falls through to the encrypted store.
    }
    const credential = await this.#encryptedFile.get(key);
    return {
      credential,
      source: credential === null ? 'none' : 'encrypted-file',
    };
  }

  async login(input: AuthLoginInput): Promise<void> {
    if (input.credential.type !== 'api-key' || input.credential.secret.length === 0) {
      throw new PlinthwayError('AUTH_FAILED', 'This authentication plugin requires an API key');
    }
    const key = this.#account(input.account);
    try {
      await this.#keyring.set(key, input.credential);
      await this.#encryptedFile.delete(key);
    } catch {
      await this.#encryptedFile.set(key, input.credential);
    }
  }

  async logout(account?: string): Promise<void> {
    const key = this.#account(account);
    let keyringError: unknown;
    try {
      await this.#keyring.delete(key);
    } catch (error) {
      keyringError = error;
    }
    await this.#encryptedFile.delete(key);
    if (keyringError !== undefined) {
      throw new PlinthwayError(
        'AUTH_FAILED',
        'Could not fully remove the stored credential',
        {},
        {
          cause: keyringError,
        },
      );
    }
  }

  async getCredentials(account?: string): Promise<Credential | null> {
    return (await this.#lookup(account)).credential;
  }

  async status(account?: string): Promise<AuthStatus> {
    const lookup = await this.#lookup(account);
    return { available: lookup.credential !== null, source: lookup.source };
  }
}

export class NoneAuthPlugin implements AuthPlugin {
  readonly id = 'none';
  readonly providerId = 'local';

  login(): Promise<void> {
    return Promise.resolve();
  }

  logout(): Promise<void> {
    return Promise.resolve();
  }

  getCredentials(): Promise<Credential> {
    return Promise.resolve({ type: 'none' });
  }

  status(): Promise<AuthStatus> {
    return Promise.resolve({ available: true, source: 'none' });
  }
}

interface RegisteredRedaction {
  readonly dispose: () => void;
}

export class AuthService {
  readonly #plugins: ReadonlyMap<string, AuthPlugin>;
  readonly #redactions = new Map<string, RegisteredRedaction>();

  constructor(plugins: readonly AuthPlugin[]) {
    const registry = new Map<string, AuthPlugin>();
    for (const plugin of plugins) {
      if (registry.has(plugin.id)) {
        throw new PlinthwayError('AUTH_FAILED', `Duplicate authentication plugin ${plugin.id}`);
      }
      registry.set(plugin.id, plugin);
    }
    this.#plugins = registry;
  }

  #plugin(id: string): AuthPlugin {
    const plugin = this.#plugins.get(id);
    if (plugin === undefined) {
      throw new PlinthwayError('AUTH_FAILED', `Authentication plugin ${id} is not registered`);
    }
    return plugin;
  }

  #redactionKey(pluginId: string, account?: string): string {
    return `${pluginId}:${account ?? DEFAULT_ACCOUNT}`;
  }

  #register(pluginId: string, credential: Credential, account?: string): void {
    const secret = credentialSecret(credential);
    if (secret === undefined || secret.length === 0) return;
    const key = this.#redactionKey(pluginId, account);
    this.#redactions.get(key)?.dispose();
    this.#redactions.set(key, { dispose: registerRedactionSecret(secret) });
  }

  async login(pluginId: string, input: AuthLoginInput): Promise<void> {
    const plugin = this.#plugin(pluginId);
    await plugin.login(input);
    this.#register(pluginId, input.credential, input.account);
  }

  async logout(pluginId: string, account?: string): Promise<void> {
    await this.#plugin(pluginId).logout(account);
    const key = this.#redactionKey(pluginId, account);
    this.#redactions.get(key)?.dispose();
    this.#redactions.delete(key);
  }

  async status(pluginId: string, account?: string): Promise<AuthStatus> {
    return this.#plugin(pluginId).status(account);
  }

  async getCredentials(pluginId: string, account?: string): Promise<Credential> {
    const credential = await this.#plugin(pluginId).getCredentials(account);
    if (credential === null) {
      throw new PlinthwayError(
        'CREDENTIAL_MISSING',
        'No credential is available for this provider',
        {
          pluginId,
        },
      );
    }
    this.#register(pluginId, credential, account);
    return credential;
  }
}

export interface DefaultAuthServiceOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly credentialsFile: string;
  readonly passphrase?: () => Promise<string>;
  readonly keyring?: CredentialStore;
}

export function createDefaultAuthService(options: DefaultAuthServiceOptions): AuthService {
  const environment = new EnvironmentCredentialStore(options.environment);
  const keyring = options.keyring ?? new KeyringCredentialStore();
  const passphrase =
    options.passphrase ??
    (() => {
      const value =
        options.environment.PLINTHWAY_CREDENTIAL_PASSPHRASE ??
        options.environment.HARNESS_CREDENTIAL_PASSPHRASE;
      if (value === undefined || value.length === 0) {
        throw new PlinthwayError(
          'CREDENTIAL_MISSING',
          'An encrypted credential passphrase is required',
        );
      }
      return Promise.resolve(value);
    });
  const encryptedFile = new EncryptedFileCredentialStore(options.credentialsFile, passphrase);
  return new AuthService([
    new ApiKeyAuthPlugin({
      id: 'openai-api-key',
      providerId: 'openai',
      environmentVariable: 'OPENAI_API_KEY',
      environment,
      keyring,
      encryptedFile,
    }),
    new ApiKeyAuthPlugin({
      id: 'anthropic-api-key',
      providerId: 'anthropic',
      environmentVariable: 'ANTHROPIC_API_KEY',
      environment,
      keyring,
      encryptedFile,
    }),
    new ApiKeyAuthPlugin({
      id: 'google-api-key',
      providerId: 'google',
      environmentVariable: 'GOOGLE_GENERATIVE_AI_API_KEY',
      environment,
      keyring,
      encryptedFile,
    }),
    new NoneAuthPlugin(),
  ]);
}
