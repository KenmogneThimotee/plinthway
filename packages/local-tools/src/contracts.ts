import type { JsonValue, ToolDescriptor } from '@plinthway/shared';

export interface FilesystemLimits {
  readonly maxTextBytes: number;
  readonly maxResultBytes: number;
  readonly maxListEntries: number;
  readonly maxSearchMatches: number;
  readonly maxSearchBytes: number;
}

export const DEFAULT_FILESYSTEM_LIMITS: FilesystemLimits = Object.freeze({
  maxTextBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxListEntries: 500,
  maxSearchMatches: 200,
  maxSearchBytes: 100 * 1024 * 1024,
});

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const mutating = { readOnlyHint: false, openWorldHint: false } as const;

function objectSchema(
  properties: Readonly<Record<string, JsonValue>>,
  required: readonly string[] = [],
): JsonValue {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const filesystemTools: ToolDescriptor[] = [
  {
    name: 'filesystem.create_directory',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Create a directory inside the current workspace.',
    inputSchema: objectSchema(
      { path: { type: 'string', minLength: 1 }, recursive: { type: 'boolean' } },
      ['path'],
    ),
    annotations: { ...mutating, idempotentHint: true },
    intrinsicAction: 'ask',
  },
  {
    name: 'filesystem.glob',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Find workspace paths matching a glob pattern.',
    inputSchema: objectSchema(
      {
        pattern: { type: 'string', minLength: 1 },
        base: { type: 'string', minLength: 1 },
        includeHidden: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      ['pattern'],
    ),
    annotations: readOnly,
    intrinsicAction: 'allow',
  },
  {
    name: 'filesystem.list',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'List one workspace directory.',
    inputSchema: objectSchema({
      path: { type: 'string', minLength: 1 },
      includeHidden: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    }),
    annotations: readOnly,
    intrinsicAction: 'allow',
  },
  {
    name: 'filesystem.move',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Move or rename a workspace entry.',
    inputSchema: objectSchema(
      {
        source: { type: 'string', minLength: 1 },
        destination: { type: 'string', minLength: 1 },
        overwrite: { type: 'boolean' },
      },
      ['source', 'destination'],
    ),
    annotations: mutating,
    intrinsicAction: 'ask',
  },
  {
    name: 'filesystem.read_text',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Read UTF-8 text from a workspace file.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', minLength: 1 },
        startLine: { type: 'integer', minimum: 1 },
        maxLines: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      ['path'],
    ),
    annotations: readOnly,
    intrinsicAction: 'allow',
  },
  {
    name: 'filesystem.remove',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Remove a workspace file or directory.',
    inputSchema: objectSchema(
      { path: { type: 'string', minLength: 1 }, recursive: { type: 'boolean' } },
      ['path'],
    ),
    annotations: { ...mutating, destructiveHint: true },
    intrinsicAction: 'ask',
  },
  {
    name: 'filesystem.search_text',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Search workspace text files for a literal string.',
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 1 },
        base: { type: 'string', minLength: 1 },
        include: { type: 'string', minLength: 1 },
        caseSensitive: { type: 'boolean' },
        includeHidden: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      ['query'],
    ),
    annotations: readOnly,
    intrinsicAction: 'allow',
  },
  {
    name: 'filesystem.stat',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Inspect metadata for a workspace entry.',
    inputSchema: objectSchema({ path: { type: 'string', minLength: 1 } }, ['path']),
    annotations: readOnly,
    intrinsicAction: 'allow',
  },
  {
    name: 'filesystem.write_text',
    source: { kind: 'builtin', id: 'filesystem' },
    description: 'Create or atomically overwrite a UTF-8 workspace file.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        mode: { enum: ['create', 'overwrite'] },
        createParents: { type: 'boolean' },
      },
      ['path', 'content', 'mode'],
    ),
    annotations: mutating,
    intrinsicAction: 'ask',
  },
];

export const FILESYSTEM_TOOLS: readonly ToolDescriptor[] = filesystemTools.sort((left, right) =>
  left.name.localeCompare(right.name),
);
