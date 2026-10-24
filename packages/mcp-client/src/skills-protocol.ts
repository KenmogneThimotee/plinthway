import { z } from 'zod';

import { PlinthwayError } from '@plinthway/shared';

import type { McpSkill, McpSkillDirectoryEntry, McpSkillFile, McpSkillResource } from './skills.js';

const MAX_PAGES = 64;

const cacheFields = {
  // The modern SDK's wire codec validates and removes resultType before custom schemas run.
  resultType: z.literal('complete').optional(),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(['public', 'private']),
  nextCursor: z.string().min(1).optional(),
} as const;

const skillResourceSchema = z.strictObject({
  uri: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  size: z.number().int().nonnegative(),
});

const skillSchema = z.strictObject({
  uri: z.string().min(1),
  frontmatter: z
    .object({ name: z.string().min(1), description: z.string().min(1) })
    .catchall(z.json()),
  resources: z.union([z.array(skillResourceSchema), z.literal('dynamic')]),
  _meta: z.record(z.string(), z.json()).optional(),
});

const listSkillsResultSchema = z.strictObject({
  ...cacheFields,
  skills: z.array(skillSchema),
});

const getSkillResultSchema = z.strictObject({
  resultType: cacheFields.resultType,
  ttlMs: cacheFields.ttlMs,
  cacheScope: cacheFields.cacheScope,
  skill: skillSchema,
});

const directoryResourceSchema = z.looseObject({
  uri: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1).optional(),
});

const directoryResultSchema = z.strictObject({
  ...cacheFields,
  resources: z.array(directoryResourceSchema),
});

export interface McpSkillCacheHint {
  readonly ttlMs: number;
  readonly cacheScope: 'public' | 'private';
}

export type McpSkillProtocolRequest = (
  request: { readonly method: string; readonly params?: Record<string, unknown> },
  resultSchema?: unknown,
  options?: { readonly timeout?: number; readonly signal?: AbortSignal },
) => Promise<unknown>;

interface Cached<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function protocolError(serverId: string, operation: string, error: unknown): PlinthwayError {
  if (error instanceof PlinthwayError) return error;
  return new PlinthwayError(
    'MCP_PROTOCOL_ERROR',
    `MCP server ${serverId} returned an invalid ${operation} result`,
    { serverId, operation },
    error instanceof Error ? { cause: error } : undefined,
  );
}

function skillFrom(serverId: string, value: z.output<typeof skillSchema>): McpSkill {
  return {
    serverId,
    uri: value.uri,
    frontmatter: value.frontmatter,
    resources:
      value.resources === 'dynamic'
        ? value.resources
        : value.resources.map((item): McpSkillResource => ({ ...item })),
    ...(value._meta === undefined ? {} : { meta: value._meta }),
  };
}

function mergedScope(
  current: 'public' | 'private',
  next: 'public' | 'private',
): 'public' | 'private' {
  return current === 'private' || next === 'private' ? 'private' : 'public';
}

export class McpSkillsProtocol {
  readonly #serverId: string;
  readonly #request: McpSkillProtocolRequest;
  readonly #directoryRead: boolean;
  readonly #now: () => number;
  #listCache: Cached<readonly McpSkill[]> | undefined;
  readonly #getCache = new Map<string, Cached<McpSkill>>();
  listCacheHint: McpSkillCacheHint | undefined;

  constructor(
    serverId: string,
    request: McpSkillProtocolRequest,
    options: { readonly directoryRead?: boolean; readonly now?: () => number } = {},
  ) {
    this.#serverId = serverId;
    this.#request = request;
    this.#directoryRead = options.directoryRead === true;
    this.#now = options.now ?? Date.now;
  }

  async list(options: { readonly refresh?: boolean } = {}): Promise<readonly McpSkill[]> {
    if (
      options.refresh !== true &&
      this.#listCache !== undefined &&
      this.#listCache.expiresAt > this.#now()
    ) {
      return this.#listCache.value;
    }
    const skills: McpSkill[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let ttlMs = Number.POSITIVE_INFINITY;
    let cacheScope: 'public' | 'private' = 'public';
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const raw = await this.#request(
          {
            method: 'skills/list',
            ...(cursor === undefined ? { params: {} } : { params: { cursor } }),
          },
          listSkillsResultSchema,
          { timeout: 10_000 },
        );
        const result = listSkillsResultSchema.parse(raw);
        skills.push(...result.skills.map((entry) => skillFrom(this.#serverId, entry)));
        ttlMs = Math.min(ttlMs, result.ttlMs);
        cacheScope = mergedScope(cacheScope, result.cacheScope);
        if (result.nextCursor === undefined) {
          const hint = { ttlMs: Number.isFinite(ttlMs) ? ttlMs : 0, cacheScope };
          this.listCacheHint = hint;
          const value = Object.freeze([...skills]);
          this.#listCache = { value, expiresAt: this.#now() + hint.ttlMs };
          return value;
        }
        if (cursors.has(result.nextCursor)) {
          throw new Error('skills/list pagination cursor repeated');
        }
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error('skills/list exceeded 64 pages');
    } catch (error) {
      throw protocolError(this.#serverId, 'skills/list', error);
    }
  }

  async get(uri: string, options: { readonly refresh?: boolean } = {}): Promise<McpSkill> {
    const cached = this.#getCache.get(uri);
    if (options.refresh !== true && cached !== undefined && cached.expiresAt > this.#now()) {
      return cached.value;
    }
    try {
      const raw = await this.#request(
        { method: 'skills/get', params: { uri } },
        getSkillResultSchema,
        { timeout: 10_000 },
      );
      const result = getSkillResultSchema.parse(raw);
      const value = skillFrom(this.#serverId, result.skill);
      this.#getCache.set(uri, { value, expiresAt: this.#now() + result.ttlMs });
      return value;
    } catch (error) {
      throw protocolError(this.#serverId, 'skills/get', error);
    }
  }

  async readDirectory(uri: string): Promise<readonly McpSkillDirectoryEntry[]> {
    if (!this.#directoryRead) {
      throw new PlinthwayError(
        'CAPABILITY_UNSUPPORTED',
        `MCP server ${this.#serverId} does not support resources/directory/read`,
        { serverId: this.#serverId },
      );
    }
    const resources: McpSkillDirectoryEntry[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const raw = await this.#request(
          {
            method: 'resources/directory/read',
            params: { uri, ...(cursor === undefined ? {} : { cursor }) },
          },
          directoryResultSchema,
          { timeout: 10_000 },
        );
        const result = directoryResultSchema.parse(raw);
        resources.push(
          ...result.resources.map((entry) => ({
            uri: entry.uri,
            name: entry.name,
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
          })),
        );
        if (result.nextCursor === undefined) return resources;
        if (cursors.has(result.nextCursor)) {
          throw new Error('resources/directory/read pagination cursor repeated');
        }
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error('resources/directory/read exceeded 64 pages');
    } catch (error) {
      throw protocolError(this.#serverId, 'resources/directory/read', error);
    }
  }
}

export function decodeSkillResourceResult(
  expectedUri: string,
  result: { readonly contents: readonly unknown[] },
): Omit<McpSkillFile, 'serverId' | 'skillUri' | 'verified'> {
  if (result.contents.length !== 1) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      'MCP skill resource read must return exactly one content block',
      { uri: expectedUri },
    );
  }
  const content = result.contents[0];
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new PlinthwayError('MCP_PROTOCOL_ERROR', 'MCP skill resource content is invalid', {
      uri: expectedUri,
    });
  }
  const record = content as Readonly<Record<string, unknown>>;
  if (record.uri !== expectedUri) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      'MCP skill resource URI does not match request',
      {
        uri: expectedUri,
      },
    );
  }
  const hasText = typeof record.text === 'string';
  const hasBlob = typeof record.blob === 'string';
  if (hasText === hasBlob) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      'MCP skill resource must contain exactly one of text or blob',
      { uri: expectedUri },
    );
  }
  let bytes: Buffer;
  if (hasText) {
    bytes = Buffer.from(record.text as string, 'utf8');
  } else {
    const blob = record.blob as string;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(blob)) {
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', 'MCP skill resource blob is invalid base64', {
        uri: expectedUri,
      });
    }
    bytes = Buffer.from(blob, 'base64');
  }
  return {
    uri: expectedUri,
    bytes,
    ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
  };
}
