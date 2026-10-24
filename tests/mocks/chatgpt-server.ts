export interface ChatGptFixtureRequest {
  readonly url: string;
  readonly authorization?: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function functionName(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = functionName(entry);
      if (name !== undefined) return name;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'function' && typeof record.name === 'string') return record.name;
  for (const nested of Object.values(record)) {
    const name = functionName(nested);
    if (name !== undefined) return name;
  }
  return undefined;
}

function eventStream(events: readonly unknown[]): Response {
  const contents = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(contents, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fixture' },
  });
}

export function createChatGptFetchFixture(): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: ChatGptFixtureRequest[];
} {
  const requests: ChatGptFixtureRequest[] = [];
  return {
    requests,
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.openai.com/v1/models') {
        return Promise.resolve(
          Response.json({
            models: [{ slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' }],
          }),
        );
      }
      if (url !== 'https://api.openai.com/v1/responses') {
        throw new Error(`Unexpected ChatGPT fixture request: ${url}`);
      }
      const headers = new Headers(init?.headers);
      const rawBody = init?.body;
      if (typeof rawBody !== 'string') throw new TypeError('Expected JSON request body');
      const body = JSON.parse(rawBody) as Readonly<Record<string, unknown>>;
      const authorization = headers.get('authorization');
      requests.push({
        url,
        ...(authorization === null ? {} : { authorization }),
        body,
      });
      const name = functionName(body.tools);
      if (name === undefined) throw new Error('Fixture expected a function tool');
      const item = {
        type: 'function_call',
        id: 'item-1',
        call_id: 'call-1',
        name,
        arguments: '{"command":"pwd"}',
        status: 'completed',
      };
      return Promise.resolve(
        eventStream([
          {
            type: 'response.created',
            response: {
              id: 'response-1',
              created_at: 1,
              model: 'gpt-test',
              service_tier: 'default',
            },
          },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'item-1',
            output_index: 0,
            delta: '{"command":"pwd"}',
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 4,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 2,
                output_tokens_details: { reasoning_tokens: 0 },
              },
              reasoning: null,
              service_tier: 'default',
            },
          },
        ]),
      );
    },
  };
}
