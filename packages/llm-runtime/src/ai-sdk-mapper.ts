import { PlinthwayError, type JsonValue, type LLMEvent } from '@plinthway/shared';

interface StreamPart {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PartialToolCall {
  toolName: string;
  input: string;
}

function asPart(value: unknown): StreamPart | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined;
  return typeof value.type === 'string' ? (value as StreamPart) : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usage(value: unknown): { inputTokens: number; outputTokens: number } {
  if (typeof value !== 'object' || value === null) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: number('inputTokens' in value ? value.inputTokens : undefined),
    outputTokens: number('outputTokens' in value ? value.outputTokens : undefined),
  };
}

export function mapFinishReason(value: unknown): LLMEvent & { type: 'finish' } {
  switch (value) {
    case 'stop':
    case 'tool-calls':
    case 'length':
      return { type: 'finish', reason: value };
    case 'abort':
    case 'cancelled':
      return { type: 'finish', reason: 'cancelled' };
    default:
      return { type: 'finish', reason: 'error' };
  }
}

function parseToolInput(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new PlinthwayError(
      'PROVIDER_ERROR',
      'Provider returned malformed tool input',
      {},
      {
        cause: error,
      },
    );
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['statusCode', 'status'] as const) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function providerDetails(error: unknown): {
  readonly providerError?: string;
  readonly parameter?: string;
  readonly requestId?: string;
} {
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Record<string, unknown>;
  const data =
    typeof record.data === 'object' && record.data !== null
      ? (record.data as Record<string, unknown>)
      : undefined;
  const nested =
    typeof data?.error === 'object' && data.error !== null
      ? (data.error as Record<string, unknown>)
      : data;
  const providerError = typeof nested?.code === 'string' ? nested.code : undefined;
  const parameter = typeof nested?.param === 'string' ? nested.param : undefined;
  const responseHeaders = record.responseHeaders;
  let requestId: string | undefined;
  if (responseHeaders instanceof Headers)
    requestId = responseHeaders.get('x-request-id') ?? undefined;
  else if (typeof responseHeaders === 'object' && responseHeaders !== null) {
    const value = (responseHeaders as Record<string, unknown>)['x-request-id'];
    if (typeof value === 'string') requestId = value;
  }
  return {
    ...(providerError === undefined ? {} : { providerError }),
    ...(parameter === undefined ? {} : { parameter }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export function mapProviderError(error: unknown, signal?: AbortSignal): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  const name = error instanceof Error ? error.name : '';
  if (signal?.aborted === true || name === 'AbortError') {
    return new PlinthwayError('CANCELLED', 'Model request was cancelled', {}, { cause: error });
  }
  if (name === 'TimeoutError') {
    return new PlinthwayError('TIMEOUT', 'Model request timed out', {}, { cause: error });
  }
  const status = statusCode(error);
  const details = providerDetails(error);
  if (details.providerError === 'server_is_overloaded') {
    return new PlinthwayError('PROVIDER_ERROR', 'ChatGPT is temporarily overloaded', details, {
      cause: error,
    });
  }
  if (
    details.providerError === 'usage_limit_reached' ||
    details.providerError === 'rate_limit_exceeded'
  ) {
    return new PlinthwayError('RATE_LIMITED', 'ChatGPT plan usage limit reached', details, {
      cause: error,
    });
  }
  if (
    details.providerError === 'unsupported_parameter' ||
    details.providerError === 'unsupported_feature'
  ) {
    return new PlinthwayError(
      'CAPABILITY_UNSUPPORTED',
      'ChatGPT does not support a requested capability',
      details,
      { cause: error },
    );
  }
  if (status === 401 || status === 403) {
    return new PlinthwayError('AUTH_FAILED', 'Model provider rejected the credential', details, {
      cause: error,
    });
  }
  if (status === 429) {
    return new PlinthwayError('RATE_LIMITED', 'Model provider rate limit reached', details, {
      cause: error,
    });
  }
  return new PlinthwayError('PROVIDER_ERROR', 'Model provider request failed', details, {
    cause: error,
  });
}

export async function* mapAISDKStream(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
  mapToolName: (name: string) => string = (name) => name,
  requireFinish = false,
): AsyncGenerator<LLMEvent> {
  const partial = new Map<string, PartialToolCall>();
  const emitted = new Set<string>();

  const complete = (callId: string, toolName: string, input: JsonValue): LLMEvent | undefined => {
    if (emitted.has(callId)) return undefined;
    emitted.add(callId);
    partial.delete(callId);
    return { type: 'tool-call', callId, toolName: mapToolName(toolName), input };
  };

  let finished = false;

  try {
    for await (const raw of stream) {
      const part = asPart(raw);
      if (part === undefined) continue;
      if ((part.type === 'text' || part.type === 'text-delta') && typeof part.text === 'string') {
        yield { type: 'text-delta', text: part.text };
      } else if (
        (part.type === 'reasoning' || part.type === 'reasoning-delta') &&
        typeof part.text === 'string'
      ) {
        yield { type: 'reasoning-delta', text: part.text };
      } else if (part.type === 'tool-input-start' && typeof part.id === 'string') {
        partial.set(part.id, {
          toolName: typeof part.toolName === 'string' ? part.toolName : '',
          input: '',
        });
      } else if (part.type === 'tool-input-delta' && typeof part.id === 'string') {
        const current = partial.get(part.id) ?? { toolName: '', input: '' };
        current.input += typeof part.delta === 'string' ? part.delta : '';
        partial.set(part.id, current);
      } else if (part.type === 'tool-call-delta' && typeof part.toolCallId === 'string') {
        const current = partial.get(part.toolCallId) ?? {
          toolName: typeof part.toolName === 'string' ? part.toolName : '',
          input: '',
        };
        current.input += typeof part.argsTextDelta === 'string' ? part.argsTextDelta : '';
        partial.set(part.toolCallId, current);
      } else if (part.type === 'tool-input-end' && typeof part.id === 'string') {
        const current = partial.get(part.id);
        if (current !== undefined && current.input.length > 0) {
          const event = complete(part.id, current.toolName, parseToolInput(current.input));
          if (event !== undefined) yield event;
        }
      } else if (part.type === 'tool-call') {
        const callId =
          typeof part.toolCallId === 'string'
            ? part.toolCallId
            : typeof part.id === 'string'
              ? part.id
              : undefined;
        if (callId !== undefined && typeof part.toolName === 'string' && 'input' in part) {
          const event = complete(callId, part.toolName, part.input as JsonValue);
          if (event !== undefined) yield event;
        }
      } else if (part.type === 'abort') {
        throw new PlinthwayError('CANCELLED', 'Model request was cancelled');
      } else if (part.type === 'error') {
        throw mapProviderError(part.error, signal);
      } else if (part.type === 'finish') {
        for (const [callId, current] of partial) {
          if (current.input.length > 0) {
            const event = complete(callId, current.toolName, parseToolInput(current.input));
            if (event !== undefined) yield event;
          }
        }
        const totals = usage(part.totalUsage);
        yield { type: 'usage', ...totals };
        yield mapFinishReason(part.finishReason);
        finished = true;
      }
    }
    if (requireFinish && !finished) {
      throw new PlinthwayError(
        'PROVIDER_ERROR',
        'ChatGPT response stream ended before response.completed',
      );
    }
  } catch (error) {
    throw mapProviderError(error, signal);
  }
}
