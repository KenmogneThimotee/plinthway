import type { LanguageModel } from 'ai';

import { PlinthwayError } from '@plinthway/shared';

import type { ProviderAdapterFactory } from '../contracts.js';

interface AnthropicModule {
  createAnthropic(options: { apiKey: string }): (modelId: string) => LanguageModel;
}

export type AnthropicImporter = () => Promise<AnthropicModule>;

export function anthropicAdapterFactory(
  importer: AnthropicImporter = async () => import('@ai-sdk/anthropic'),
): ProviderAdapterFactory {
  return async () => {
    const sdk = await importer();
    return {
      providerId: 'anthropic',
      createModel({ modelId, credential }) {
        if (credential.type !== 'api-key') {
          return Promise.reject(
            new PlinthwayError('CREDENTIAL_MISSING', 'Anthropic requires an API key'),
          );
        }
        return Promise.resolve(sdk.createAnthropic({ apiKey: credential.secret })(modelId));
      },
    };
  };
}
