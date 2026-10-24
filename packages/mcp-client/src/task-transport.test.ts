import { describe, expect, it, vi } from 'vitest';

import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client';

import { TaskMultiplexTransport } from './task-transport.js';

class FakeTransport implements Transport {
  readonly sent: { message: JSONRPCMessage; options?: TransportSendOptions }[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, ...(options === undefined ? {} : { options }) });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

describe('TaskMultiplexTransport', () => {
  it('routes raw task responses away from the SDK client and applies routing headers', async () => {
    const inner = new FakeTransport();
    const transport = new TaskMultiplexTransport(inner);
    const sdkMessages: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      sdkMessages.push(message);
    };
    await transport.start();

    const pending = transport.dispatch(
      { method: 'tasks/get', params: { taskId: 'task-1' } },
      { context: { headers: { Authorization: 'Bearer value' }, requestTimeoutMs: 1_000 } },
    );
    await vi.waitFor(() => {
      expect(inner.sent).toHaveLength(1);
    });
    const sent = inner.sent[0];
    expect(sent?.message).toMatchObject({
      jsonrpc: '2.0',
      method: 'tasks/get',
      params: { taskId: 'task-1' },
    });
    expect(sent?.options?.headers).toMatchObject({
      Authorization: 'Bearer value',
      'Mcp-Method': 'tasks/get',
      'Mcp-Name': 'task-1',
    });
    const id = (sent?.message as { id?: string } | undefined)?.id;
    if (id === undefined) throw new Error('missing raw request ID');
    inner.onmessage?.({ jsonrpc: '2.0', id, result: { status: 'working' } });

    await expect(pending).resolves.toEqual({
      kind: 'result',
      result: { status: 'working' },
    });
    expect(sdkMessages).toEqual([]);
  });

  it('forwards unrelated traffic and rejects aborted raw requests without leaking ownership', async () => {
    const inner = new FakeTransport();
    const transport = new TaskMultiplexTransport(inner);
    const sdkMessages: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      sdkMessages.push(message);
    };
    await transport.start();
    inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tasks', params: {} });
    expect(sdkMessages).toHaveLength(1);

    const controller = new AbortController();
    const pending = transport.dispatch(
      { method: 'tasks/get', params: { taskId: 'task-2' } },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);

    const id = (inner.sent.at(-1)?.message as { id?: string } | undefined)?.id;
    if (id === undefined) throw new Error('missing raw request ID');
    inner.onmessage?.({ jsonrpc: '2.0', id, result: { status: 'completed' } });
    expect(sdkMessages).toHaveLength(2);
  });

  it('treats a tools/call result without resultType as complete', async () => {
    const inner = new FakeTransport();
    const transport = new TaskMultiplexTransport(inner);
    const sdkMessages: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      sdkMessages.push(message);
    };
    await transport.start();

    await transport.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'legacy-result', arguments: {} },
    });
    inner.onmessage?.({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'done' }] },
    });

    expect(sdkMessages).toEqual([
      {
        jsonrpc: '2.0',
        id: 7,
        result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
      },
    ]);
  });
});
