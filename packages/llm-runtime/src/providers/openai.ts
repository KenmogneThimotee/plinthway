import type { LanguageModel } from 'ai';

import { PlinthwayError } from '@plinthway/shared';

import type { ProviderAdapterFactory } from '../contracts.js';

interface OpenAIModule {
  createOpenAI(options: { apiKey: string }): (modelId: string) => LanguageModel;
}

export type OpenAIImporter = () => Promise<OpenAIModule>;

export function openAIAdapterFactory(
  importer: OpenAIImporter = async () => import('@ai-sdk/openai'),
): ProviderAdapterFactory {
  return async () => {
    const sdk = await importer();
    return {
      providerId: 'openai',
      createModel({ modelId, credential }) {
        if (credential.type !== 'api-key') {
          return Promise.reject(
            new PlinthwayError('CREDENTIAL_MISSING', 'OpenAI requires an API key'),
          );
        }
        return Promise.resolve(sdk.createOpenAI({ apiKey: credential.secret })(modelId));
      },
    };
  };
}
