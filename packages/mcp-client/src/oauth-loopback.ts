import { createServer } from 'node:http';

import { PlinthwayError } from '@plinthway/shared';

export interface OAuthLoopbackResult {
  readonly code: string;
  readonly state: string;
  readonly issuer?: string;
}

export interface OAuthLoopbackCallback {
  readonly redirectUrl: URL;
  readonly result: Promise<OAuthLoopbackResult>;
  readonly close: () => Promise<void>;
}

export interface OAuthLoopbackOptions {
  readonly expectedState: string;
  readonly timeoutMs?: number;
}

export async function startOAuthLoopbackCallback(
  options: OAuthLoopbackOptions,
): Promise<OAuthLoopbackCallback> {
  let resolveResult: (value: OAuthLoopbackResult) => void;
  let rejectResult: (error: PlinthwayError) => void;
  let settled = false;
  const result = new Promise<OAuthLoopbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settleError = (message: string): void => {
    if (settled) return;
    settled = true;
    rejectResult(new PlinthwayError('AUTH_FAILED', message));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const issuer = url.searchParams.get('iss');
    const oauthError = url.searchParams.get('error');
    if (oauthError !== null) {
      settleError(`OAuth authorization failed: ${oauthError}`);
      response.writeHead(400).end('Authorization failed. You may close this window.');
      return;
    }
    if (code === null || state !== options.expectedState) {
      settleError('OAuth callback state did not match');
      response.writeHead(400).end('Invalid OAuth callback. You may close this window.');
      return;
    }
    if (!settled) {
      settled = true;
      resolveResult({
        code,
        state,
        ...(issuer === null ? {} : { issuer }),
      });
    }
    response
      .writeHead(200)
      .end('Authorization received. Return to the terminal while the connection completes.');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new PlinthwayError('AUTH_FAILED', 'Could not allocate an OAuth callback port');
  }
  const timeout = setTimeout(
    () => {
      settleError('OAuth callback timed out');
      server.close();
    },
    options.timeoutMs ?? 5 * 60_000,
  );
  timeout.unref();
  let closed = false;
  return {
    redirectUrl: new URL(`http://127.0.0.1:${String(address.port)}/oauth/callback`),
    result,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        clearTimeout(timeout);
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
