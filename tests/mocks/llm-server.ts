import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type MockLlmMode =
  | 'text'
  | 'tool-call'
  | 'reasoning'
  | 'auth-error'
  | 'unsupported'
  | 'disconnect'
  | 'delay'
  | 'late-after-abort';

export interface MockLlmRequest {
  readonly path: string;
  readonly authorization?: string;
  readonly body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
}

function sse(response: ServerResponse, chunks: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

export async function startMockLlmServer(mode: MockLlmMode = 'text'): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly MockLlmRequest[];
  readonly close: () => Promise<void>;
}> {
  const requests: MockLlmRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push({
        path: request.url ?? '/',
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        body: await readBody(request),
      });
      if (mode === 'auth-error') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid credential', type: 'auth' } }));
        return;
      }
      if (mode === 'unsupported') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'tools unsupported' } }));
        return;
      }
      if (mode === 'disconnect') {
        response.destroy();
        return;
      }
      if (mode === 'delay' || mode === 'late-after-abort') {
        setTimeout(() => {
          if (!response.destroyed || mode === 'late-after-abort') {
            sse(response, [{ choices: [{ delta: { content: 'late' } }] }]);
          }
        }, 100);
        return;
      }
      if (mode === 'tool-call') {
        sse(response, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'files_read', arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/a"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
        ]);
        return;
      }
      if (mode === 'reasoning') {
        sse(response, [{ choices: [{ delta: { reasoning_content: 'checking' } }] }]);
        return;
      }
      sse(response, [
        { choices: [{ delta: { content: 'hello ' } }] },
        { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing mock address');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
