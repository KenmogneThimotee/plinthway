import { describe, expect, it } from 'vitest';

import type { PlinthwayError } from '@plinthway/shared';

import { compileToolValidator } from './validation.js';

describe('MCP tool validation', () => {
  it('accepts valid arguments and rejects invalid arguments before invocation', () => {
    const validate = compileToolValidator('files', 'write', {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    });

    expect(validate({ path: '/tmp/a' })).toEqual({ path: '/tmp/a' });
    expect(() => validate({ path: 42 })).toThrow(
      expect.objectContaining<Partial<PlinthwayError>>({ code: 'TOOL_ARGUMENTS_INVALID' }),
    );
  });

  it('accepts MCP tool schemas declared as JSON Schema 2020-12', () => {
    const validate = compileToolValidator('filesystem', 'read_file', {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        path: { type: 'string' },
        tail: { type: 'number' },
        head: { type: 'number' },
      },
      required: ['path'],
    });

    expect(validate({ path: '/home/ada/Documents/readme.txt' })).toEqual({
      path: '/home/ada/Documents/readme.txt',
    });
    expect(() => validate({ path: 42 })).toThrow(
      expect.objectContaining<Partial<PlinthwayError>>({ code: 'TOOL_ARGUMENTS_INVALID' }),
    );
  });

  it('rejects pathological schemas before adding them to the catalog', () => {
    let deep: unknown = { type: 'string' };
    for (let index = 0; index < 40; index += 1) deep = { properties: { next: deep } };

    expect(() => compileToolValidator('bad', 'deep', deep)).toThrow(
      expect.objectContaining<Partial<PlinthwayError>>({ code: 'MCP_PROTOCOL_ERROR' }),
    );
    expect(() =>
      compileToolValidator('bad', 'wide', {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 1_001 }, (_, index) => [
            `field${String(index)}`,
            { type: 'string' },
          ]),
        ),
      }),
    ).toThrow(expect.objectContaining<Partial<PlinthwayError>>({ code: 'MCP_PROTOCOL_ERROR' }));
  });
});
