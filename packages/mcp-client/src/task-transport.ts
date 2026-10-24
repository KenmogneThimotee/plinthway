import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client';
import {
  DispatchError,
  type DispatchOptions,
  type JsonRpcResponse,
} from '@modelcontextprotocol/ext-tasks/client';
import { isJsonValue, type JsonValue } from '@modelcontextprotocol/ext-tasks/core';

interface PendingRequest {
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

function requestRecord(request: JsonValue): Readonly<Record<string, JsonValue>> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new DispatchError('MCP task request must be a JSON object');
  }
  const record = request as Readonly<Record<string, JsonValue>>;
  if (typeof record.method !== 'string') {
    throw new DispatchError('MCP task request method must be a string');
  }
  return record;
}

function taskRoutingHeaders(
  request: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, string>> {
  const method = request.method as string;
  const params = request.params;
  const taskId =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Readonly<Record<string, JsonValue>>).taskId
      : undefined;
  if (typeof taskId === 'string' && /[\r\n]/u.test(taskId)) {
    throw new DispatchError('MCP task ID cannot contain HTTP header delimiters');
  }
  return {
    'Mcp-Method': method,
    ...(typeof taskId === 'string' ? { 'Mcp-Name': taskId } : {}),
  };
}

export class TaskMultiplexTransport implements Transport {
  readonly #inner: Transport;
  readonly #sendInner: Transport['send'];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #toolCallRequests = new Set<string>();
  #nextId = 0;
  #started = false;
  readonly hasPerRequestStream?: boolean;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(inner: Transport) {
    this.#inner = inner;
    this.#sendInner = inner.send.bind(inner);
    if (inner.hasPerRequestStream !== undefined) {
      this.hasPerRequestStream = inner.hasPerRequestStream;
    }
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId;
  }

  set sessionId(value: string | undefined) {
    this.#inner.sessionId = value;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('Task multiplex transport is already started');
    this.#started = true;
    this.#installCallbacks();
    await this.#inner.start();
  }

  attachStarted(): void {
    if (this.#started) throw new Error('Task multiplex transport is already started');
    this.#started = true;
    if (this.#inner.onmessage !== undefined) this.onmessage = this.#inner.onmessage;
    if (this.#inner.onerror !== undefined) this.onerror = this.#inner.onerror;
    if (this.#inner.onclose !== undefined) this.onclose = this.#inner.onclose;
    this.#installCallbacks();
    this.#inner.send = this.send.bind(this);
  }

  #installCallbacks(): void {
    this.#inner.onmessage = (message, extra) => {
      if ('id' in message && typeof message.id === 'string') {
        const pending = this.#pending.get(message.id);
        if (pending !== undefined && ('result' in message || 'error' in message)) {
          this.#pending.delete(message.id);
          pending.cleanup();
          if ('error' in message) {
            pending.resolve({
              kind: 'error',
              error: {
                code: message.error.code,
                message: message.error.message,
                ...(message.error.data === undefined || !isJsonValue(message.error.data)
                  ? {}
                  : { data: message.error.data }),
              },
            });
          } else if (isJsonValue(message.result)) {
            pending.resolve({ kind: 'result', result: message.result });
          } else {
            pending.reject(new DispatchError('MCP task response was not valid JSON'));
          }
          return;
        }
      }
      const messageId = 'id' in message ? String(message.id) : undefined;
      const isToolCallResponse =
        messageId !== undefined && this.#toolCallRequests.delete(messageId);
      if (
        isToolCallResponse &&
        'result' in message &&
        typeof message.result === 'object' &&
        !Array.isArray(message.result) &&
        !('resultType' in message.result)
      ) {
        this.onmessage?.(
          { ...message, result: { resultType: 'complete', ...message.result } },
          extra,
        );
        return;
      }
      this.onmessage?.(message, extra);
    };
    this.#inner.onerror = (error) => this.onerror?.(error);
    this.#inner.onclose = () => {
      const error = new DispatchError('MCP task transport closed', true);
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.#pending.clear();
      this.#toolCallRequests.clear();
      this.onclose?.();
    };
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const messageId = 'id' in message ? String(message.id) : undefined;
    if ('method' in message && message.method === 'tools/call' && messageId !== undefined) {
      this.#toolCallRequests.add(messageId);
    }
    return this.#sendInner(message, options).catch((error: unknown) => {
      if (messageId !== undefined) this.#toolCallRequests.delete(messageId);
      throw error;
    });
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.#inner.setSupportedProtocolVersions?.(versions);
  }

  dispatch(request: JsonValue, options: DispatchOptions = {}): Promise<JsonRpcResponse> {
    const record = requestRecord(request);
    if (!this.#started) {
      return Promise.reject(new DispatchError('MCP task transport is not started'));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new DispatchError('MCP task request was aborted'));
    }
    const id = `plinthway-task:${String(++this.#nextId)}`;
    const requestController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
    };
    const result = new Promise<JsonRpcResponse>((resolve, reject) => {
      const abort = (message: string): void => {
        if (!this.#pending.delete(id)) return;
        requestController.abort();
        cleanup();
        reject(new DispatchError(message, true));
      };
      onAbort = () => {
        abort('MCP task request was aborted');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutMs = options.context?.requestTimeoutMs;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          abort('MCP task request timed out');
        }, timeoutMs);
        timeout.unref();
      }
      this.#pending.set(id, { resolve, reject, cleanup });
    });
    const message = {
      jsonrpc: '2.0',
      id,
      ...record,
    } as JSONRPCMessage;
    const headers = {
      ...options.context?.headers,
      ...taskRoutingHeaders(record),
    };
    void this.#inner
      .send(message, {
        requestSignal: requestController.signal,
        headers,
      })
      .catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.cleanup();
        pending.reject(
          new DispatchError('MCP task request could not be sent', true, {
            cause: error,
          }),
        );
      });
    return result;
  }
}
