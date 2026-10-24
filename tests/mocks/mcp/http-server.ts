import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: { readonly protocolVersion?: string; readonly arguments?: unknown };
}

async function readJson(request: IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
}

function send(response: ServerResponse, id: string | number, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

export async function startHttpMcpServer(
  options: {
    readonly mode?: 'normal' | 'malformed-schema' | 'failure' | 'oversized' | 'hung';
  } = {},
): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const message = await readJson(request);
    if (message.id === undefined) {
      response.writeHead(202).end();
    } else if (message.method === 'initialize') {
      send(response, message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      if (options.mode === 'malformed-schema') {
        send(response, message.id, {
          tools: [{ name: 'broken', inputSchema: { type: 'definitely-not-json-schema' } }],
        });
        return;
      }
      send(response, message.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo text',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: { text: { type: 'string' } },
            },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    } else {
      if (options.mode === 'hung') return;
      send(response, message.id, {
        content: [
          {
            type: 'text',
            text:
              options.mode === 'oversized'
                ? 'x'.repeat(1024 * 1024 + 1)
                : JSON.stringify(message.params?.arguments ?? {}),
          },
        ],
        isError: options.mode === 'failure',
      });
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
