import { createInterface } from 'node:readline';

function respond(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

const lines = createInterface({ input: process.stdin });
const mode = process.env.PLINTHWAY_MCP_FIXTURE_MODE ?? 'normal';
lines.on('line', (line) => {
  const message = JSON.parse(line) as {
    id?: string | number;
    method?: string;
    params?: { name?: string; arguments?: unknown; protocolVersion?: string };
  };
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    if (mode === 'malformed-schema') {
      respond(message.id, {
        tools: [{ name: 'broken', inputSchema: { type: 'definitely-not-json-schema' } }],
      });
      return;
    }
    respond(message.id, {
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
        {
          name: 'wait',
          description: 'Never completes',
          inputSchema: { type: 'object', additionalProperties: false },
        },
        {
          name: 'pid',
          description: 'Return the fixture process ID',
          inputSchema: { type: 'object', additionalProperties: false },
        },
      ],
    });
  } else if (message.method === 'tools/call' && message.params?.name !== 'wait') {
    if (mode === 'failure') {
      respond(message.id, { content: [{ type: 'text', text: 'fixture failure' }], isError: true });
      return;
    }
    if (mode === 'oversized') {
      respond(message.id, { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }] });
      return;
    }
    respond(message.id, {
      content: [
        {
          type: 'text',
          text:
            message.params?.name === 'pid'
              ? String(process.pid)
              : JSON.stringify(message.params?.arguments ?? {}),
        },
      ],
      isError: false,
    });
  }
});
