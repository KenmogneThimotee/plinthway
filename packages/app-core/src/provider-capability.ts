import { secureUrlSchema } from '@plinthway/config';
import type { CatalogAdapterDeclaration } from '@plinthway/llm-runtime';
import type { ProviderMetadata } from '@plinthway/model-registry';
import type { ProfileProvider } from '@plinthway/profiles';

export type ProviderExecutionStatus = 'ready' | 'setup-required' | 'adapter-required';

export interface ProviderSetupDescriptor {
  readonly providerId: string;
  readonly providerName: string;
  readonly adapter: ProfileProvider['adapter'];
  readonly baseURL?: string;
  readonly authMode: 'none' | 'api-key';
  readonly envName?: string;
}

export interface ProviderCapability {
  readonly status: ProviderExecutionStatus;
  readonly setup?: ProviderSetupDescriptor;
  readonly packageName?: string;
  readonly authVariables: readonly string[];
  readonly endpoint?: string;
  readonly documentation?: string;
  readonly reason?: string;
}

export type { CatalogAdapterDeclaration } from '@plinthway/llm-runtime';

function details(provider: ProviderMetadata) {
  return {
    ...(provider.npm === undefined ? {} : { packageName: provider.npm }),
    authVariables: provider.env,
    ...(provider.api === undefined ? {} : { endpoint: provider.api }),
    ...(provider.doc === undefined ? {} : { documentation: provider.doc }),
  };
}

function setupDescriptor(
  provider: ProviderMetadata,
  adapter: ProfileProvider['adapter'],
  authMode: 'none' | 'api-key',
  baseURL?: string,
): ProviderSetupDescriptor {
  return Object.freeze({
    providerId: provider.id,
    providerName: provider.name,
    adapter,
    ...(baseURL === undefined ? {} : { baseURL }),
    authMode,
    ...(authMode === 'api-key' && provider.env[0] !== undefined
      ? { envName: provider.env[0] }
      : {}),
  });
}

export function resolveProviderCapability(input: {
  readonly provider: ProviderMetadata;
  readonly configured?: ProfileProvider;
  readonly credentialAvailable: boolean;
  readonly registeredAdapters: ReadonlySet<ProfileProvider['adapter']>;
  readonly declarations: readonly CatalogAdapterDeclaration[];
}): ProviderCapability {
  const common = details(input.provider);
  const configured = input.configured;
  if (configured !== undefined) {
    if (!input.registeredAdapters.has(configured.adapter)) {
      return Object.freeze({
        status: 'adapter-required',
        ...common,
        reason: `The ${configured.adapter} adapter is not registered`,
      });
    }
    if (configured.auth.mode !== 'api-key' || input.credentialAvailable) {
      return Object.freeze({ status: 'ready', ...common });
    }
    return Object.freeze({
      status: 'setup-required',
      ...common,
      setup: setupDescriptor(input.provider, configured.adapter, 'api-key', configured.baseURL),
      reason: 'An API key is required for this profile',
    });
  }

  const declaration = input.declarations.find(({ packages }) =>
    input.provider.npm === undefined ? false : packages.includes(input.provider.npm),
  );
  if (declaration === undefined) {
    return Object.freeze({
      status: 'adapter-required',
      ...common,
      reason: 'No built-in adapter supports this provider package',
    });
  }
  if (!input.registeredAdapters.has(declaration.adapter)) {
    return Object.freeze({
      status: 'adapter-required',
      ...common,
      reason: `The ${declaration.adapter} adapter is not registered`,
    });
  }
  if (input.provider.env.length > 1) {
    return Object.freeze({
      status: 'adapter-required',
      ...common,
      reason: 'This provider requires multiple authentication variables',
    });
  }

  let baseURL: string | undefined;
  if (declaration.requiresBaseURL) {
    const endpoint = secureUrlSchema.safeParse(input.provider.api);
    if (!endpoint.success) {
      return Object.freeze({
        status: 'adapter-required',
        ...common,
        reason: 'A secure HTTPS or loopback endpoint is required',
      });
    }
    baseURL = endpoint.data;
  }
  const authMode = input.provider.env.length === 0 ? 'none' : 'api-key';
  return Object.freeze({
    status: 'setup-required',
    ...common,
    setup: setupDescriptor(input.provider, declaration.adapter, authMode, baseURL),
  });
}
