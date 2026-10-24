import type { LanguageModel } from 'ai';

import { PlinthwayError } from '@plinthway/shared';

import type { ProviderAdapterFactory } from '../contracts.js';

interface GoogleModule {
  createGoogleGenerativeAI(options: { apiKey: string }): (modelId: string) => LanguageModel;
}

export type GoogleImporter = () => Promise<GoogleModule>;

export function googleAdapterFactory(
  importer: GoogleImporter = async () => import('@ai-sdk/google'),
): ProviderAdapterFactory {
  return async () => {
    const sdk = await importer();
    return {
      providerId: 'google',
      createModel({ modelId, credential }) {
        if (credential.type !== 'api-key') {
          return Promise.reject(
            new PlinthwayError('CREDENTIAL_MISSING', 'Google requires an API key'),
          );
        }
        return Promise.resolve(
          sdk.createGoogleGenerativeAI({ apiKey: credential.secret })(modelId),
        );
      },
    };
  };
}
