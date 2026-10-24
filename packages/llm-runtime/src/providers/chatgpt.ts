import type { LanguageModel } from 'ai';

import type { ChatGptTokenProvider } from '@plinthway/auth';
import { PlinthwayError } from '@plinthway/shared';

import type { ProviderAdapterFactory } from '../contracts.js';

const RESOURCE_ORIGIN = 'https://api.openai.com';
const RESPONSES_URL = `${RESOURCE_ORIGIN}/v1/responses`;

interface OpenAIResponsesProvider {
  responses(modelId: string): LanguageModel;
}

interface OpenAIResponsesOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface OpenAIResponsesImporter {
  (): Promise<{
    createOpenAI(options: OpenAIResponsesOptions): OpenAIResponsesProvider;
  }>;
}

export interface ChatGptAdapterOptions {
  readonly accounts: ChatGptTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly importer?: OpenAIResponsesImporter;
}

function sanitizedBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') {
    throw new PlinthwayError('PROVIDER_ERROR', 'ChatGPT Responses requests must use a JSON body');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new PlinthwayError(
      'PROVIDER_ERROR',
      'ChatGPT Responses request body is invalid',
      {},
      { cause: error },
    );
  }
  for (const field of [
    'temperature',
    'max_output_tokens',
    'max_completion_tokens',
    'service_tier',
    'user',
  ])
    parsed[field] = undefined;
  parsed.store = false;
  parsed.stream = true;
  return JSON.stringify(parsed);
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

function requireCompletedEvent(response: Response): Response {
  if (
    !response.ok ||
    response.body === null ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    return response;
  }
  const decoder = new TextDecoder();
  let tail = '';
  let completed = false;
  const completedPattern = /"type"\s*:\s*"response\.completed"/u;
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const searchable = `${tail}${text}`;
        completed ||= completedPattern.test(searchable);
        tail = searchable.slice(-256);
        controller.enqueue(chunk);
      },
      flush() {
        completed ||= completedPattern.test(`${tail}${decoder.decode()}`);
        if (!completed) {
          throw new PlinthwayError(
            'PROVIDER_ERROR',
            'ChatGPT response stream ended before response.completed',
          );
        }
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function lockedFetch(
  connectionId: string,
  accounts: ChatGptTokenProvider,
  fetchImplementation: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (url !== RESPONSES_URL) {
      throw new PlinthwayError(
        'NETWORK_DENIED',
        'ChatGPT credentials can only be sent to OpenAI Responses',
        {
          origin: new URL(url).origin,
        },
      );
    }
    if (init?.method?.toUpperCase() !== 'POST') {
      throw new PlinthwayError('NETWORK_DENIED', 'ChatGPT Responses requests must use POST');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    for (const name of ['authorization', 'openai-organization', 'openai-project', 'x-api-key']) {
      headers.delete(name);
    }
    const body = sanitizedBody(
      init.body ?? (input instanceof Request ? await input.clone().text() : undefined),
    );
    return accounts.withAccessToken(
      connectionId,
      async (accessToken) => {
        headers.set('authorization', `Bearer ${accessToken}`);
        headers.set('content-type', 'application/json');
        const response = await fetchImplementation(RESPONSES_URL, {
          ...init,
          method: 'POST',
          headers,
          body,
          redirect: 'error',
        });
        if (response.status >= 300 && response.status < 400) {
          throw new PlinthwayError('NETWORK_DENIED', 'OpenAI Responses redirected unexpectedly', {
            status: response.status,
          });
        }
        return requireCompletedEvent(response);
      },
      init.signal ?? undefined,
    );
  };
}

export function chatGptAdapterFactory(options: ChatGptAdapterOptions): ProviderAdapterFactory {
  return async () => {
    const sdk = await (options.importer ?? (async () => import('@ai-sdk/openai')))();
    return {
      providerId: 'chatgpt',
      createModel({ modelId, baseURL, credential, connectionId }) {
        if (baseURL !== undefined) {
          return Promise.reject(
            new PlinthwayError('CONFIG_INVALID', 'ChatGPT does not allow a custom API URL'),
          );
        }
        if (credential.type !== 'none' || connectionId === undefined) {
          return Promise.reject(
            new PlinthwayError(
              'CREDENTIAL_MISSING',
              'ChatGPT requires a connected subscription account',
            ),
          );
        }
        const provider = sdk.createOpenAI({
          apiKey: 'keyring-token-is-injected-per-request',
          baseURL: `${RESOURCE_ORIGIN}/v1`,
          fetch: lockedFetch(connectionId, options.accounts, options.fetch ?? globalThis.fetch),
        });
        return Promise.resolve(provider.responses(modelId));
      },
    };
  };
}
