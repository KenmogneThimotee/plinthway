import type { LanguageModel } from 'ai';

import { PlinthwayError } from '@plinthway/shared';

import type { ProviderAdapterFactory } from '../contracts.js';

interface OpenAICompatibleModule {
  createOpenAICompatible(options: {
    baseURL: string;
    name: string;
    apiKey?: string;
    fetch: typeof fetch;
  }): (modelId: string) => LanguageModel;
}

export type OpenAICompatibleImporter = () => Promise<OpenAICompatibleModule>;

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  );
}

function validateBaseURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new PlinthwayError(
      'ADAPTER_UNSUPPORTED',
      'OpenAI-compatible base URL is invalid',
      {},
      {
        cause: error,
      },
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new PlinthwayError(
      'NETWORK_DENIED',
      'OpenAI-compatible endpoints require HTTPS or loopback',
    );
  }
  return url;
}

export function originLockedFetch(baseURL: URL, fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    const requestURL = new URL(input instanceof Request ? input.url : input.toString(), baseURL);
    if (requestURL.origin !== baseURL.origin) {
      throw new PlinthwayError(
        'NETWORK_DENIED',
        'Provider request attempted to leave its configured origin',
      );
    }
    const response = await fetchImplementation(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new PlinthwayError('NETWORK_DENIED', 'Provider redirects are not followed');
    }
    return response;
  };
}

export function openAICompatibleAdapterFactory(
  importer: OpenAICompatibleImporter = async () => import('@ai-sdk/openai-compatible'),
  fetchImplementation: typeof fetch = globalThis.fetch,
): ProviderAdapterFactory {
  return async () => {
    const sdk = await importer();
    return {
      providerId: 'openai-compatible',
      createModel({ modelId, baseURL, credential }) {
        if (baseURL === undefined) {
          return Promise.reject(
            new PlinthwayError(
              'ADAPTER_UNSUPPORTED',
              'OpenAI-compatible providers require a base URL',
            ),
          );
        }
        if (credential.type === 'oauth') {
          return Promise.reject(
            new PlinthwayError('CREDENTIAL_MISSING', 'OAuth is not supported for local providers'),
          );
        }
        const url = validateBaseURL(baseURL);
        const provider = sdk.createOpenAICompatible({
          baseURL: url.toString().replace(/\/$/u, ''),
          name: 'plinthway',
          ...(credential.type === 'api-key' ? { apiKey: credential.secret } : {}),
          fetch: originLockedFetch(url, fetchImplementation),
        });
        return Promise.resolve(provider(modelId));
      },
    };
  };
}
