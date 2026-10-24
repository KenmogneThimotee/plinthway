import type { ProviderConfig } from '@plinthway/config';
import type { ChatGptTokenProvider } from '@plinthway/auth';

import type { ProviderAdapterFactory } from '../contracts.js';
import { anthropicAdapterFactory } from './anthropic.js';
import { googleAdapterFactory } from './google.js';
import { openAICompatibleAdapterFactory } from './openai-compatible.js';
import { openAIAdapterFactory } from './openai.js';
import { chatGptAdapterFactory } from './chatgpt.js';

export function createDefaultAdapterFactories(
  options: {
    readonly chatgpt?: ChatGptTokenProvider;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Readonly<Partial<Record<ProviderConfig['adapter'], ProviderAdapterFactory>>> {
  return {
    openai: openAIAdapterFactory(),
    anthropic: anthropicAdapterFactory(),
    google: googleAdapterFactory(),
    'openai-compatible': openAICompatibleAdapterFactory(),
    ...(options.chatgpt === undefined
      ? {}
      : {
          'openai-chatgpt': chatGptAdapterFactory({
            accounts: options.chatgpt,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        }),
  };
}

export interface CatalogAdapterDeclaration {
  readonly adapter: ProviderConfig['adapter'];
  readonly packages: readonly string[];
  readonly requiresBaseURL: boolean;
}

const CATALOG_ADAPTER_DECLARATIONS: readonly CatalogAdapterDeclaration[] = Object.freeze([
  Object.freeze({
    adapter: 'openai',
    packages: Object.freeze(['@ai-sdk/openai']),
    requiresBaseURL: false,
  }),
  Object.freeze({
    adapter: 'anthropic',
    packages: Object.freeze(['@ai-sdk/anthropic']),
    requiresBaseURL: false,
  }),
  Object.freeze({
    adapter: 'google',
    packages: Object.freeze(['@ai-sdk/google']),
    requiresBaseURL: false,
  }),
  Object.freeze({
    adapter: 'openai-compatible',
    packages: Object.freeze(['@ai-sdk/openai-compatible']),
    requiresBaseURL: true,
  }),
]);

export function defaultCatalogAdapterDeclarations(): readonly CatalogAdapterDeclaration[] {
  return CATALOG_ADAPTER_DECLARATIONS;
}

export * from './anthropic.js';
export * from './google.js';
export * from './openai-compatible.js';
export * from './openai.js';
export * from './chatgpt.js';
