/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import type { ChatGptTokenProvider } from '@plinthway/auth';

import { chatGptAdapterFactory, type OpenAIResponsesImporter } from './chatgpt.js';

describe('chatGptAdapterFactory', () => {
  it('uses the Responses model and injects a fresh token at the fixed resource boundary', async () => {
    let providerOptions: Record<string, unknown> | undefined;
    let lockedFetch: typeof globalThis.fetch | undefined;
    const responses = vi.fn(() => ({ modelId: 'gpt-test' }) as never);
    const importer: OpenAIResponsesImporter = async () => ({
      createOpenAI(options) {
        providerOptions = options as unknown as Record<string, unknown>;
        lockedFetch = options.fetch;
        return { responses };
      },
    });
    let tokenReads = 0;
    const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
    const accounts: ChatGptTokenProvider = {
      withAccessToken: async (_id, operation) => {
        tokenReads += 1;
        return operation(`fresh-${String(tokenReads)}`);
      },
    };
    const adapter = await chatGptAdapterFactory({
      accounts,
      importer,
      fetch: async (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
        const rawBody = init?.body;
        if (typeof rawBody !== 'string') throw new TypeError('Expected JSON request body');
        requests.push({
          url,
          ...(init === undefined ? {} : { init }),
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
        return Response.json({ ok: true });
      },
    })();
    await adapter.createModel({
      modelId: 'gpt-test',
      credential: { type: 'none' },
      connectionId: 'account-one',
    });

    expect(providerOptions).toMatchObject({ baseURL: 'https://api.openai.com/v1' });
    expect(responses).toHaveBeenCalledWith('gpt-test');
    if (lockedFetch === undefined) throw new Error('Expected a locked fetch');
    await lockedFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer placeholder',
        'openai-organization': 'must-not-leak',
        'openai-project': 'must-not-leak',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-test',
        stream: false,
        store: true,
        temperature: 0.7,
        max_output_tokens: 99,
      }),
    });
    expect(requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      init: { redirect: 'error' },
      body: { model: 'gpt-test', stream: true, store: false },
    });
    expect(requests[0]?.body).not.toHaveProperty('temperature');
    expect(requests[0]?.body).not.toHaveProperty('max_output_tokens');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer fresh-1');
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
  });

  it('rejects every non-Responses destination before reading a token', async () => {
    let lockedFetch: typeof globalThis.fetch | undefined;
    let tokenReads = 0;
    const accounts: ChatGptTokenProvider = {
      withAccessToken: async <T>(
        _connectionId: string,
        operation: (token: string) => Promise<T>,
      ) => {
        tokenReads += 1;
        return operation('must-not-be-used');
      },
    };
    const adapter = await chatGptAdapterFactory({
      accounts,
      importer: async () => ({
        createOpenAI(options) {
          lockedFetch = options.fetch;
          return { responses: () => ({}) as never };
        },
      }),
      fetch: vi.fn(),
    })();
    await adapter.createModel({
      modelId: 'gpt-test',
      credential: { type: 'none' },
      connectionId: 'account-one',
    });
    if (lockedFetch === undefined) throw new Error('Expected a locked fetch');

    await expect(lockedFetch('https://evil.example/v1/responses', {})).rejects.toMatchObject({
      code: 'NETWORK_DENIED',
    });
    expect(tokenReads).toBe(0);
  });

  it('rejects a successful stream that ends without response.completed', async () => {
    let lockedFetch: typeof globalThis.fetch | undefined;
    const adapter = await chatGptAdapterFactory({
      accounts: {
        withAccessToken: async (_id, operation) => operation('fresh-token'),
      },
      importer: async () => ({
        createOpenAI(options) {
          lockedFetch = options.fetch;
          return { responses: () => ({}) as never };
        },
      }),
      fetch: async () =>
        new Response(
          'data: {"type":"response.created","response":{"id":"one"}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })();
    await adapter.createModel({
      modelId: 'gpt-test',
      credential: { type: 'none' },
      connectionId: 'account-one',
    });
    if (lockedFetch === undefined) throw new Error('Expected a locked fetch');

    const response = await lockedFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-test' }),
    });
    await expect(response.text()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
