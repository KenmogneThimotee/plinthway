import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  RESOURCE_MIME_TYPE,
  SUPPORTED_PROTOCOL_VERSIONS,
  McpUiInitializeRequestSchema,
  McpUiInitializedNotificationSchema,
  McpUiSizeChangedNotificationSchema,
  buildAllowAttribute,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { PlinthwayError, canonicalJson, type JsonValue } from '@plinthway/shared';

import type { McpAppDescriptor } from './catalog.js';

const DEFAULT_RESOURCE_BYTES = 16 * 1024 * 1024;
const DEFAULT_BRIDGE_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set([
  'ping',
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/notifications/size-changed',
  'ui/notifications/request-teardown',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
]);

export interface AppResourceResult {
  readonly contents: readonly unknown[];
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface AppToolCall {
  readonly appSessionId: string;
  readonly auditSessionId: string;
  readonly callId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly source: 'mcp-app';
  readonly resourceUri: string;
}

export interface AppInvocationContext {
  readonly auditSessionId: string;
}

export interface AppToolResult {
  readonly content: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface McpAppHostOptions {
  readonly readResource: (serverId: string, uri: string) => Promise<AppResourceResult>;
  readonly callTool: (request: AppToolCall) => Promise<AppToolResult>;
  readonly listTools: (
    serverId: string,
  ) => readonly { readonly toolName: string; readonly visibility: readonly ('model' | 'app')[] }[];
  readonly listToolDefinitions?: (serverId: string) => readonly unknown[];
  readonly listResources?: (serverId: string) => readonly unknown[];
  readonly authorizeOrigin?: (origin: string) => Promise<boolean>;
  readonly maxResourceBytes?: number;
  readonly maxBridgeBytes?: number;
}

interface LoadedResource {
  readonly html: string;
  readonly csp: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, unknown>>;
}

export interface AppSession {
  readonly id: string;
  readonly origin: string;
  readonly proxyOrigin: string;
  readonly url: string;
  readonly token: string;
  readonly descriptor: McpAppDescriptor;
  readonly closed: boolean;
  close(): Promise<void>;
  waitUntilClosed(signal?: AbortSignal): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Loopback renderer did not receive a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
}

function send(
  response: ServerResponse,
  status: number,
  body = '',
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, canonicalJson(value), { 'Content-Type': 'application/json' });
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function body(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum)
      throw new PlinthwayError('PAYLOAD_TOO_LARGE', 'MCP App bridge payload exceeds its limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function loadResource(
  result: AppResourceResult,
  uri: string,
  maximum: number,
  listing?: unknown,
): LoadedResource {
  const candidate = result.contents.find((item) => record(item)?.uri === uri);
  const content = record(candidate);
  if (content === undefined || typeof content.text !== 'string') {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP App resource ${uri} did not contain text HTML`,
      { uri },
    );
  }
  if (content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP App resource ${uri} has an invalid MIME type`,
      { uri },
    );
  }
  if (Buffer.byteLength(content.text) > maximum) {
    throw new PlinthwayError(
      'PAYLOAD_TOO_LARGE',
      `MCP App resource ${uri} exceeds ${String(maximum)} bytes`,
      { uri },
    );
  }
  const contentUi = record(record(content._meta)?.ui);
  const listingUi = record(record(record(listing)?._meta)?.ui);
  const ui = contentUi ?? listingUi;
  return {
    html: content.text,
    csp: record(ui?.csp) ?? {},
    permissions: record(ui?.permissions) ?? {},
  };
}

function safeDomains(
  value: unknown,
  protocols: readonly string[] = ['https:', 'http:'],
): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => {
    if (typeof item !== 'string' || /[\s;'"\\]/u.test(item)) return false;
    try {
      const normalized = item.replace('://*.', '://wildcard.');
      const url = new URL(normalized);
      return (
        protocols.includes(url.protocol) &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === '' &&
        url.origin === normalized
      );
    } catch {
      return false;
    }
  });
}

function appCsp(csp: Readonly<Record<string, unknown>>): string {
  const connect = safeDomains(csp.connectDomains, ['https:', 'http:', 'wss:', 'ws:']);
  const resource = safeDomains(csp.resourceDomains);
  const frames = safeDomains(csp.frameDomains);
  const base = safeDomains(csp.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resource.join(' ')}`.trim(),
    `style-src 'unsafe-inline' ${resource.join(' ')}`.trim(),
    `img-src data: blob: ${resource.join(' ')}`.trim(),
    `font-src ${resource.join(' ') || "'none'"}`,
    `media-src ${resource.join(' ') || "'none'"}`,
    `connect-src ${connect.join(' ') || "'none'"}`,
    `frame-src ${frames.join(' ') || "'none'"}`,
    "object-src 'none'",
    `base-uri ${base.join(' ') || "'self'"}`,
    "form-action 'none'",
  ].join('; ');
}

function withCsp(html: string, csp: Readonly<Record<string, unknown>>): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${appCsp(csp).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`)
    : `${meta}${html}`;
}

function outerPage(proxyOrigin: string): string {
  return `<!doctype html><meta charset="utf-8"><title>MCP App</title><style>html,body,iframe{border:0;margin:0;width:100%;height:100%}</style><iframe title="MCP App sandbox" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe><script>const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);document.querySelector('iframe').src=${JSON.stringify(`${proxyOrigin}/sandbox`)}+'#'+encodeURIComponent(token);</script>`;
}

function proxyPage(appOrigin: string, allow: string): string {
  return `<!doctype html><meta charset="utf-8"><title>MCP App proxy</title><iframe title="MCP App" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="${allow.replaceAll('"', '&quot;')}" src="${appOrigin}/app"></iframe><script>(()=>{const token=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);const frame=document.querySelector('iframe');const target=${JSON.stringify(appOrigin)};const failure=(id,status)=>({jsonrpc:'2.0',id:id??null,error:{code:-32000,message:'Bridge request failed ('+status+')'}});addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.origin!==target||!event.data||typeof event.data.method!=='string')return;let payload;try{const response=await fetch('/bridge',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(event.data)});if(response.status===204)return;const body=await response.text();try{payload=body?JSON.parse(body):failure(event.data.id,response.status)}catch{payload=failure(event.data.id,response.status)}}catch{payload=failure(event.data.id,0)}frame.contentWindow.postMessage(payload,target);});})();</script>`;
}

class Session implements AppSession {
  #closed = false;
  #resolveClosed: (() => void) | undefined;
  readonly #closedPromise = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  constructor(
    readonly id: string,
    readonly origin: string,
    readonly proxyOrigin: string,
    readonly token: string,
    readonly descriptor: McpAppDescriptor,
    readonly url: string,
    private readonly servers: readonly Server[],
    private readonly onClose: () => void,
  ) {}
  get closed(): boolean {
    return this.#closed;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    try {
      await Promise.all(this.servers.map(stop));
    } finally {
      this.#resolveClosed?.();
      this.#resolveClosed = undefined;
    }
  }
  async waitUntilClosed(signal?: AbortSignal): Promise<void> {
    if (this.#closed) return;
    if (signal === undefined) return this.#closedPromise;
    if (signal.aborted) {
      await this.close();
      return;
    }
    const onAbort = (): void => {
      void this.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.#closedPromise;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export class McpAppHost {
  readonly #sessions = new Set<Session>();
  constructor(private readonly options: McpAppHostOptions) {}

  list(): readonly AppSession[] {
    return [...this.#sessions];
  }

  async #sanitizeCsp(
    csp: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result: Record<string, readonly string[]> = {};
    const authorize = this.options.authorizeOrigin ?? (() => Promise.resolve(false));
    for (const [key, protocols] of [
      ['connectDomains', ['https:', 'http:', 'wss:', 'ws:']],
      ['resourceDomains', ['https:', 'http:']],
      ['frameDomains', ['https:', 'http:']],
      ['baseUriDomains', ['https:', 'http:']],
    ] as const) {
      const allowed: string[] = [];
      for (const origin of safeDomains(csp[key], protocols)) {
        if (await authorize(origin)) allowed.push(origin);
      }
      if (allowed.length > 0) result[key] = allowed;
    }
    return result;
  }

  async open(descriptor: McpAppDescriptor, context: AppInvocationContext): Promise<AppSession> {
    const listing = this.options
      .listResources?.(descriptor.serverId)
      .find((entry) => record(entry)?.uri === descriptor.resourceUri);
    const untrusted = loadResource(
      await this.options.readResource(descriptor.serverId, descriptor.resourceUri),
      descriptor.resourceUri,
      this.options.maxResourceBytes ?? DEFAULT_RESOURCE_BYTES,
      listing,
    );
    const loaded: LoadedResource = {
      ...untrusted,
      csp: await this.#sanitizeCsp(untrusted.csp),
    };
    const token = randomBytes(32).toString('base64url');
    const appSessionId = randomBytes(16).toString('hex');
    let appOrigin = '';
    const app = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/app') {
        send(response, 200, withCsp(loaded.html, loaded.csp), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': appCsp(loaded.csp),
          'Referrer-Policy': 'no-referrer',
        });
        return;
      }
      send(response, 404);
    });
    const appPort = await listen(app);
    appOrigin = `http://127.0.0.1:${String(appPort)}`;
    let proxyOrigin = '';
    let requestTeardown = (): void => undefined;
    const proxy = createServer((request, response) => {
      void this.#proxyRequest(
        request,
        response,
        proxyOrigin,
        token,
        descriptor,
        loaded,
        appOrigin,
        requestTeardown,
        appSessionId,
        context.auditSessionId,
      );
    });
    let proxyPort: number;
    try {
      proxyPort = await listen(proxy);
    } catch (error) {
      await stop(app);
      throw error;
    }
    proxyOrigin = `http://127.0.0.1:${String(proxyPort)}`;
    let origin = '';
    const outer = createServer((request, response) => {
      if (
        request.method === 'GET' &&
        (request.url === '/' || request.url?.startsWith('/#') === true)
      ) {
        send(response, 200, outerPage(proxyOrigin), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; frame-src ${proxyOrigin}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`,
          'Referrer-Policy': 'no-referrer',
        });
        return;
      }
      if (request.url === '/resource') {
        if (!authorized(request, token)) send(response, 401);
        else
          json(response, 200, {
            html: withCsp(loaded.html, loaded.csp),
            mimeType: RESOURCE_MIME_TYPE,
            csp: loaded.csp,
            permissions: loaded.permissions,
          });
        return;
      }
      send(response, 404);
    });
    try {
      const port = await listen(outer);
      origin = `http://127.0.0.1:${String(port)}`;
    } catch (error) {
      await Promise.all([stop(proxy), stop(app)]);
      throw error;
    }
    const session = new Session(
      appSessionId,
      origin,
      proxyOrigin,
      token,
      descriptor,
      `${origin}/#${token}`,
      [outer, proxy, app],
      () => this.#sessions.delete(session),
    );
    requestTeardown = () => {
      void session.close();
    };
    this.#sessions.add(session);
    return session;
  }

  async #proxyRequest(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
    token: string,
    descriptor: McpAppDescriptor,
    loaded: LoadedResource,
    appOrigin: string,
    requestTeardown: () => void,
    appSessionId: string,
    auditSessionId: string,
  ): Promise<void> {
    let requestId: JsonValue = null;
    try {
      if (request.method === 'GET' && request.url === '/sandbox') {
        send(response, 200, proxyPage(appOrigin, buildAllowAttribute(loaded.permissions)), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; frame-src ${appOrigin}; connect-src 'self'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`,
          'Referrer-Policy': 'no-referrer',
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/resource') {
        if (!authorized(request, token)) send(response, 401);
        else
          json(response, 200, {
            html: withCsp(loaded.html, loaded.csp),
            mimeType: RESOURCE_MIME_TYPE,
            csp: loaded.csp,
            permissions: loaded.permissions,
          });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/bridge') {
        send(response, 404);
        return;
      }
      if (!authorized(request, token)) {
        send(response, 401);
        return;
      }
      if (request.headers.origin !== origin) {
        send(response, 403);
        return;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        send(response, 415);
        return;
      }
      const raw = await body(request, this.options.maxBridgeBytes ?? DEFAULT_BRIDGE_BYTES);
      const message = record(JSON.parse(raw));
      if (message === undefined) {
        send(response, 400);
        return;
      }
      const method = message.method;
      requestId = (message.id as JsonValue | undefined) ?? null;
      if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
        json(response, 405, {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32601, message: 'Method not allowed' },
        });
        return;
      }
      if (method === 'ui/initialize') McpUiInitializeRequestSchema.parse(message);
      if (method === 'ui/notifications/initialized')
        McpUiInitializedNotificationSchema.parse(message);
      if (method === 'ui/notifications/size-changed')
        McpUiSizeChangedNotificationSchema.parse(message);
      if (method === 'ui/notifications/request-teardown') {
        send(response, 204);
        queueMicrotask(requestTeardown);
        return;
      }
      if (method.startsWith('ui/notifications/')) {
        send(response, 204);
        return;
      }
      const result = await this.#dispatch(
        method,
        message.params,
        descriptor,
        appSessionId,
        auditSessionId,
        requestId,
      );
      json(response, 200, { jsonrpc: '2.0', id: requestId, result });
    } catch (error) {
      if (error instanceof PlinthwayError && error.code === 'PAYLOAD_TOO_LARGE') {
        send(response, 413);
        return;
      }
      if (error instanceof PlinthwayError && error.code === 'TOOL_DENIED') {
        json(response, 403, {
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32001, message: error.message },
        });
        return;
      }
      json(response, 400, {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32600,
          message: error instanceof Error ? error.message : 'Invalid request',
        },
      });
    }
  }

  async #dispatch(
    method: string,
    value: unknown,
    descriptor: McpAppDescriptor,
    appSessionId: string,
    auditSessionId: string,
    requestId: JsonValue,
  ): Promise<unknown> {
    const params = record(value) ?? {};
    if (method === 'ping') return {};
    if (method === 'ui/initialize') {
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] ?? '2026-01-26',
        hostInfo: { name: 'plinthway', version: '0.1.0' },
        hostCapabilities: { serverTools: {}, serverResources: {} },
        hostContext: { displayMode: 'inline' },
      };
    }
    if (method === 'tools/list') {
      return {
        tools: this.options.listToolDefinitions?.(descriptor.serverId) ?? [],
        _meta: { plinthway: { trusted: false, serverId: descriptor.serverId, source: 'mcp-app' } },
      };
    }
    if (method === 'resources/read') {
      if (typeof params.uri !== 'string') throw new Error('resources/read requires a URI');
      const result = await this.options.readResource(descriptor.serverId, params.uri);
      return {
        contents: result.contents,
        _meta: {
          ...result.meta,
          plinthway: {
            trusted: false,
            serverId: descriptor.serverId,
            uri: params.uri,
            source: 'mcp-app',
          },
        },
      };
    }
    if (method === 'resources/list') {
      return {
        resources: this.options.listResources?.(descriptor.serverId) ?? [],
        _meta: { plinthway: { trusted: false, serverId: descriptor.serverId, source: 'mcp-app' } },
      };
    }
    if (method === 'tools/call') {
      if (typeof requestId !== 'string' && typeof requestId !== 'number') {
        throw new Error('tools/call requires a string or numeric request id');
      }
      if (typeof params.name !== 'string') throw new Error('tools/call requires a tool name');
      const tool = this.options
        .listTools(descriptor.serverId)
        .find((candidate) => candidate.toolName === params.name);
      if (tool === undefined || !tool.visibility.includes('app')) {
        throw new PlinthwayError(
          'TOOL_DENIED',
          `Tool ${params.name} is not visible to this MCP App`,
        );
      }
      const args = (params.arguments ?? {}) as JsonValue;
      const result = await this.options.callTool({
        appSessionId,
        auditSessionId,
        callId: String(requestId),
        serverId: descriptor.serverId,
        toolName: tool.toolName,
        arguments: args,
        source: 'mcp-app',
        resourceUri: descriptor.resourceUri,
      });
      const { meta, ...standardResult } = result;
      return {
        ...standardResult,
        _meta: {
          ...(meta ?? {}),
          plinthway: {
            trusted: false,
            serverId: descriptor.serverId,
            toolName: tool.toolName,
            source: 'mcp-app',
          },
        },
      };
    }
    throw new Error(`Unsupported MCP App method: ${method}`);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }

  async closeServer(serverId: string): Promise<void> {
    await Promise.all(
      [...this.#sessions]
        .filter((session) => session.descriptor.serverId === serverId)
        .map((session) => session.close()),
    );
  }
}
