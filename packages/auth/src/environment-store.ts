import type { Credential } from './contracts.js';

export class EnvironmentCredentialStore {
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.#environment = environment;
  }

  getApiKey(variableName: string): Credential | null {
    const secret = this.#environment[variableName];
    return secret === undefined || secret.length === 0 ? null : { type: 'api-key', secret };
  }
}
