import {
  PlinthwayError,
  type LLMMessage,
  type LLMRequest,
  type LLMResponse,
  type ToolDefinition,
} from '@plinthway/shared';

import { mapAISDKStream, mapFinishReason, mapProviderError } from './ai-sdk-mapper.js';
import { ChatGptToolMap } from './chatgpt-tools.js';
import type {
  AIGenerateResult,
  AITextFunctions,
  LLMRuntime,
  ModelRequirements,
  PreparedModelResolver,
  ProfileRuntimeBinding,
} from './contracts.js';

interface UnifiedLLMRuntimeOptions {
  readonly resolver: PreparedModelResolver;
  readonly ai?: () => Promise<AITextFunctions>;
}

function messages(
  input: readonly LLMMessage[],
  toolMap?: ChatGptToolMap,
  omitSystem = false,
): readonly unknown[] {
  return input.flatMap((message) => {
    if (omitSystem && message.role === 'system') return [];
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.callId,
            toolName: toolMap?.alias(message.toolName) ?? message.toolName,
            output: { type: 'json', value: message.content },
          },
        ],
      };
    }
    if (message.role !== 'assistant' || message.toolCalls === undefined) return message;
    return {
      role: 'assistant',
      content: [
        ...(message.content.length === 0 ? [] : [{ type: 'text', text: message.content }]),
        ...message.toolCalls.map((call) => ({
          type: 'tool-call',
          toolCallId: call.callId,
          toolName: toolMap?.alias(call.toolName) ?? call.toolName,
          input: call.input,
        })),
      ],
    };
  });
}

function tools(
  input: readonly ToolDefinition[] | undefined,
  ai: AITextFunctions,
  toolMap?: ChatGptToolMap,
): unknown {
  if (input === undefined) return undefined;
  return Object.fromEntries(
    input.map((definition) => [
      toolMap?.alias(definition.name) ?? definition.name,
      {
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: ai.jsonSchema(definition.inputSchema),
        ...(toolMap === undefined
          ? {}
          : {
              providerOptions: {
                openai: {
                  namespace: {
                    name: toolMap.namespace(definition.name),
                    description: `Local tools from ${toolMap.namespace(definition.name)}`,
                  },
                },
              },
            }),
      },
    ]),
  );
}

function toolNames(request: LLMRequest): readonly string[] {
  return [
    ...(request.tools ?? []).map(({ name }) => name),
    ...request.messages.flatMap((message) =>
      message.role === 'tool'
        ? [message.toolName]
        : message.role === 'assistant'
          ? (message.toolCalls ?? []).map(({ toolName }) => toolName)
          : [],
    ),
  ];
}

function requestOptions(
  request: LLMRequest,
  languageModel: unknown,
  adapter: string,
  ai: AITextFunctions,
  signal?: AbortSignal,
): { readonly options: Record<string, unknown>; readonly toolMap?: ChatGptToolMap } {
  const subscription = adapter === 'openai-chatgpt';
  const toolMap = subscription ? new ChatGptToolMap(toolNames(request)) : undefined;
  return {
    options: {
      model: languageModel,
      messages: messages(request.messages, toolMap, subscription),
      ...(subscription
        ? {
            instructions: request.messages
              .flatMap((message): string[] => (message.role === 'system' ? [message.content] : []))
              .join('\n\n'),
          }
        : {}),
      ...(request.tools === undefined ? {} : { tools: tools(request.tools, ai, toolMap) }),
      ...(!subscription && request.parameters?.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.parameters.maxOutputTokens }
        : {}),
      ...(!subscription && request.parameters?.temperature !== undefined
        ? { temperature: request.parameters.temperature }
        : {}),
      ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      ...(signal === undefined ? {} : { abortSignal: signal }),
      includeRawChunks: false,
      ...(subscription ? { onError: () => undefined } : {}),
      ...(adapter === 'openai'
        ? { providerOptions: { openai: { store: false } } }
        : subscription
          ? { providerOptions: { openai: { store: false, systemMessageMode: 'developer' } } }
          : {}),
    },
    ...(toolMap === undefined ? {} : { toolMap }),
  };
}

function toolCalls(result: AIGenerateResult): LLMResponse['toolCalls'] {
  return (result.toolCalls ?? []).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const callId = 'toolCallId' in value ? value.toolCallId : undefined;
    const toolName = 'toolName' in value ? value.toolName : undefined;
    const input = 'input' in value ? value.input : undefined;
    if (typeof callId !== 'string' || typeof toolName !== 'string') return [];
    return [{ callId, toolName, input: input as LLMResponse['toolCalls'][number]['input'] }];
  });
}

function usage(value: unknown): LLMResponse['usage'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const inputTokens = 'inputTokens' in value ? value.inputTokens : undefined;
  const outputTokens = 'outputTokens' in value ? value.outputTokens : undefined;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens };
}

async function defaultAI(): Promise<AITextFunctions> {
  const sdk = await import('ai');
  return {
    streamText(options) {
      return sdk.streamText(options as never);
    },
    async generateText(options) {
      return sdk.generateText(options as never);
    },
    jsonSchema(schema) {
      return sdk.jsonSchema(schema as never);
    },
  };
}

export class UnifiedLLMRuntime implements LLMRuntime {
  readonly #resolver: PreparedModelResolver;
  readonly #loadAI: () => Promise<AITextFunctions>;

  constructor(options: UnifiedLLMRuntimeOptions) {
    this.#resolver = options.resolver;
    this.#loadAI = options.ai ?? defaultAI;
  }

  async resolve(
    modelRef: string,
    requirements?: ModelRequirements,
    binding?: ProfileRuntimeBinding,
  ) {
    return (await this.#resolver.resolve(modelRef, requirements, binding)).model;
  }

  async #preparedFor(request: LLMRequest) {
    const bindingId = request.model.bindingId;
    if (bindingId !== undefined) {
      const prepared = this.#resolver.prepared(bindingId);
      if (prepared === undefined) {
        throw new PlinthwayError('PROVIDER_ERROR', 'Prepared profile model binding is unavailable');
      }
      return prepared;
    }
    return this.#resolver.resolve(request.model.ref);
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    let signal: AbortSignal | undefined;
    try {
      const prepared = await this.#preparedFor(request);
      const ai = await this.#loadAI();
      const context = requestOptions(request, prepared.languageModel, prepared.adapter, ai, signal);
      if (prepared.adapter === 'openai-chatgpt') {
        const result = await ai.streamText(context.options);
        let text = '';
        const calls: LLMResponse['toolCalls'][number][] = [];
        let normalizedUsage: LLMResponse['usage'];
        let finishReason: LLMResponse['finishReason'] = 'error';
        for await (const event of mapAISDKStream(
          result.fullStream,
          signal,
          (name) => context.toolMap?.originalName(name) ?? name,
          true,
        )) {
          if (event.type === 'text-delta') text += event.text;
          else if (event.type === 'tool-call') calls.push(event);
          else if (event.type === 'usage')
            normalizedUsage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            };
          else if (event.type === 'finish') finishReason = event.reason;
        }
        return {
          text,
          toolCalls: calls,
          ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
          finishReason,
        };
      }
      const result = await ai.generateText(context.options);
      const finish = mapFinishReason(result.finishReason);
      const normalizedUsage = usage(result.usage);
      return {
        text: result.text,
        toolCalls: toolCalls(result),
        ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
        finishReason: finish.reason,
      };
    } catch (error) {
      throw mapProviderError(error, signal);
    }
  }

  async *stream(request: LLMRequest, signal?: AbortSignal) {
    try {
      if (signal?.aborted === true) {
        throw new PlinthwayError('CANCELLED', 'Model request was cancelled');
      }
      const prepared = await this.#preparedFor(request);
      const ai = await this.#loadAI();
      const context = requestOptions(request, prepared.languageModel, prepared.adapter, ai, signal);
      const result = await ai.streamText(context.options);
      yield* mapAISDKStream(
        result.fullStream,
        signal,
        (name) => context.toolMap?.originalName(name) ?? name,
        prepared.adapter === 'openai-chatgpt',
      );
    } catch (error) {
      throw mapProviderError(error, signal);
    }
  }
}
