import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { LLMRequest, ResolvedModel } from '@plinthway/shared';

import type { AITextFunctions, PreparedModel } from './contracts.js';
import { UnifiedLLMRuntime } from './runtime.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/llm/stream.json',
);

const resolved: ResolvedModel = {
  ref: 'openai/gpt-test',
  providerId: 'openai',
  modelId: 'gpt-test',
  capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
  contextLimit: 128000,
  outputLimit: 8192,
};

async function* parts(values: readonly unknown[]) {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

function request(): LLMRequest {
  return {
    model: resolved,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'weather', inputSchema: { type: 'object' } }],
    parameters: { temperature: 0.2, maxOutputTokens: 100 },
    timeoutMs: 5000,
  };
}

function runtime(
  ai: AITextFunctions,
  adapter: PreparedModel['adapter'] = 'openai',
): UnifiedLLMRuntime {
  const prepared: PreparedModel = {
    model: resolved,
    languageModel: { id: 'fake' } as never,
    adapter,
  };
  return new UnifiedLLMRuntime({
    resolver: {
      resolve: () => Promise.resolve(prepared),
      prepared: () => prepared,
    },
    ai: () => Promise.resolve(ai),
  });
}

describe('UnifiedLLMRuntime', () => {
  it.each(['openai', 'anthropic', 'google', 'openai-compatible'] as const)(
    'maps %s text, reasoning, fragmented tool input, usage, and finish exactly once',
    async (adapter) => {
      const values = JSON.parse(await readFile(fixture, 'utf8')) as unknown[];
      let receivedOptions: Record<string, unknown> | undefined;
      const plinthway = runtime(
        {
          streamText(options) {
            receivedOptions = options;
            return { fullStream: parts(values) };
          },
          generateText() {
            return Promise.reject(new Error('unused'));
          },
          jsonSchema(schema) {
            return schema;
          },
        },
        adapter,
      );

      const events = [];
      for await (const event of plinthway.stream(request())) events.push(event);
      expect(events).toEqual([
        { type: 'text-delta', text: 'Hello ' },
        { type: 'reasoning-delta', text: 'checking' },
        { type: 'tool-call', callId: 'call-1', toolName: 'weather', input: { city: 'Paris' } },
        { type: 'usage', inputTokens: 12, outputTokens: 4 },
        { type: 'finish', reason: 'tool-calls' },
      ]);
      expect(receivedOptions).toMatchObject({
        maxOutputTokens: 100,
        temperature: 0.2,
        timeout: 5000,
        includeRawChunks: false,
        ...(adapter === 'openai' ? { providerOptions: { openai: { store: false } } } : {}),
      });
      expect((receivedOptions?.tools as Record<string, unknown>).weather).not.toHaveProperty(
        'execute',
      );
    },
  );

  it('maps tool results to the AI SDK message shape', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const plinthway = runtime({
      streamText() {
        throw new Error('unused');
      },
      generateText(options) {
        receivedOptions = options;
        return Promise.resolve({ text: 'ok', finishReason: 'stop' });
      },
      jsonSchema(schema) {
        return schema;
      },
    });
    await plinthway.generate({
      ...request(),
      messages: [
        {
          role: 'tool',
          callId: 'call-1',
          toolName: 'weather',
          content: { temperature: 20 },
        },
      ],
    });
    expect(receivedOptions?.messages).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            output: { type: 'json', value: { temperature: 20 } },
          },
        ],
      },
    ]);
  });

  it('enforces ChatGPT subscription options and reverses tool aliases', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const plinthway = runtime(
      {
        streamText(options) {
          receivedOptions = options;
          const offered = Object.keys(options.tools as Record<string, unknown>);
          return {
            fullStream: parts([
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: offered[0],
                input: { command: 'pwd' },
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                totalUsage: { inputTokens: 1, outputTokens: 1 },
              },
            ]),
          };
        },
        generateText() {
          return Promise.reject(new Error('ChatGPT generate must aggregate a stream'));
        },
        jsonSchema(schema) {
          return schema;
        },
      },
      'openai-chatgpt',
    );
    const subscriptionRequest: LLMRequest = {
      ...request(),
      tools: [{ name: 'shell.run', description: 'Run shell', inputSchema: { type: 'object' } }],
      messages: [
        { role: 'system', content: 'Be precise' },
        { role: 'user', content: 'pwd' },
      ],
    };

    await expect(plinthway.generate(subscriptionRequest)).resolves.toMatchObject({
      toolCalls: [{ toolName: 'shell.run', input: { command: 'pwd' } }],
      finishReason: 'tool-calls',
    });
    expect(receivedOptions).not.toHaveProperty('temperature');
    expect(receivedOptions).not.toHaveProperty('maxOutputTokens');
    expect(receivedOptions).toMatchObject({
      instructions: 'Be precise',
      messages: [{ role: 'user', content: 'pwd' }],
      providerOptions: { openai: { store: false, systemMessageMode: 'developer' } },
    });
    const providerLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(receivedOptions?.onError).toEqual(expect.any(Function));
      (receivedOptions?.onError as (event: { readonly error: unknown }) => void)({
        error: new Error('provider secret'),
      });
      expect(providerLog).not.toHaveBeenCalled();
    } finally {
      providerLog.mockRestore();
    }
    const offered = Object.entries(
      receivedOptions?.tools as Record<string, Record<string, unknown>>,
    );
    expect(offered).toHaveLength(1);
    expect(offered[0]?.[0]).not.toBe('shell.run');
    expect(offered[0]?.[1]).toMatchObject({
      providerOptions: { openai: { namespace: { name: 'shell' } } },
    });
  });

  it('does not prepare or invoke a provider for an already-cancelled stream', async () => {
    let resolutions = 0;
    const plinthway = new UnifiedLLMRuntime({
      resolver: {
        resolve() {
          resolutions += 1;
          return Promise.reject(new Error('must not run'));
        },
        prepared: () => undefined,
      },
      ai: () => Promise.reject(new Error('must not run')),
    });
    const controller = new AbortController();
    controller.abort();
    const consume = () => plinthway.stream(request(), controller.signal).next();
    await expect(consume()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(resolutions).toBe(0);
  });

  it('normalizes generate results', async () => {
    const plinthway = runtime({
      streamText() {
        throw new Error('unused');
      },
      generateText() {
        return Promise.resolve({
          text: 'done',
          toolCalls: [{ toolCallId: 'c1', toolName: 'weather', input: { city: 'Paris' } }],
          usage: { inputTokens: 3, outputTokens: 2 },
          finishReason: 'stop',
        });
      },
      jsonSchema(schema) {
        return schema;
      },
    });
    await expect(plinthway.generate(request())).resolves.toEqual({
      text: 'done',
      toolCalls: [{ callId: 'c1', toolName: 'weather', input: { city: 'Paris' } }],
      usage: { inputTokens: 3, outputTokens: 2 },
      finishReason: 'stop',
    });
  });

  it('reuses the exact prepared profile binding for provider calls', async () => {
    const bound = { ...resolved, bindingId: 'profile:binding' };
    const prepared: PreparedModel = {
      model: bound,
      languageModel: { id: 'bound' } as never,
      adapter: 'openai-compatible',
    };
    const resolve = vi.fn(() => Promise.reject(new Error('must not re-resolve without profile')));
    const plinthway = new UnifiedLLMRuntime({
      resolver: {
        resolve,
        prepared: (id) => (id === 'profile:binding' ? prepared : undefined),
      },
      ai: () =>
        Promise.resolve({
          streamText() {
            throw new Error('unused');
          },
          generateText() {
            return Promise.resolve({ text: 'bound', finishReason: 'stop' });
          },
          jsonSchema(schema) {
            return schema;
          },
        }),
    });

    await expect(plinthway.generate({ ...request(), model: bound })).resolves.toMatchObject({
      text: 'bound',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'CANCELLED'],
    [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'TIMEOUT'],
    [Object.assign(new Error('rate limited secret-key'), { statusCode: 429 }), 'RATE_LIMITED'],
    [Object.assign(new Error('unauthorized secret-key'), { statusCode: 401 }), 'AUTH_FAILED'],
    [new Error('provider exploded secret-key'), 'PROVIDER_ERROR'],
  ])('maps provider failure classes without copying unsafe messages', async (failure, code) => {
    const plinthway = runtime({
      streamText() {
        throw failure;
      },
      generateText() {
        return Promise.reject(failure);
      },
      jsonSchema(schema) {
        return schema;
      },
    });
    await expect(plinthway.generate(request())).rejects.toMatchObject({ code });
    try {
      await plinthway.generate(request());
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret-key');
    }
  });

  it.each([
    ['usage_limit_reached', 'RATE_LIMITED'],
    ['unsupported_parameter', 'CAPABILITY_UNSUPPORTED'],
    ['chatgpt_plan_required', 'PROVIDER_ERROR'],
  ])('maps safe ChatGPT provider code %s to %s', async (providerCode, code) => {
    const failure = Object.assign(new Error('unsafe provider text'), {
      statusCode: 400,
      data: { error: { code: providerCode, param: 'temperature' } },
      responseHeaders: { 'x-request-id': 'req_safe' },
    });
    const plinthway = runtime(
      {
        streamText() {
          throw failure;
        },
        generateText() {
          return Promise.reject(failure);
        },
        jsonSchema(schema) {
          return schema;
        },
      },
      'openai-chatgpt',
    );
    await expect(plinthway.generate(request())).rejects.toMatchObject({
      code,
      details: { providerError: providerCode, parameter: 'temperature', requestId: 'req_safe' },
    });
  });

  it('reports a ChatGPT overload as a temporary provider failure', async () => {
    const failure = Object.assign(new Error('unsafe provider text'), {
      statusCode: 503,
      data: { error: { code: 'server_is_overloaded' } },
    });
    const plinthway = runtime(
      {
        streamText() {
          throw failure;
        },
        generateText() {
          return Promise.reject(failure);
        },
        jsonSchema(schema) {
          return schema;
        },
      },
      'openai-chatgpt',
    );

    await expect(plinthway.generate(request())).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'ChatGPT is temporarily overloaded',
      details: { providerError: 'server_is_overloaded' },
    });
  });
});
