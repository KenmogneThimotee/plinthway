import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Agent, buildConnector } from 'undici';

import { PlinthwayError } from '@plinthway/shared';

export type HostLookup = (hostname: string) => Promise<readonly string[]>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESTRICTED_FETCH_BRAND = Symbol.for('plinthway.restricted-fetch');
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const SENSITIVE_FORM_FIELDS = new Set([
  'assertion',
  'client_assertion',
  'client_secret',
  'code',
  'code_verifier',
  'refresh_token',
  'subject_token',
]);
const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

async function hasSensitiveFormBody(request: Request): Promise<boolean> {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/x-www-form-urlencoded')
  ) {
    return false;
  }
  const parameters = new URLSearchParams(await request.text());
  return [...SENSITIVE_FORM_FIELDS].some((name) => parameters.has(name));
}

function denied(url: URL, reason: string): PlinthwayError {
  return new PlinthwayError('NETWORK_DENIED', `MCP network destination denied: ${reason}`, {
    origin: url.origin,
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return isLoopbackAddress(host);
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '') === 'localhost';
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return LOOPBACK_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    return isIP(embedded) === 4 ? isPrivateIpv4(embedded) : true;
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('2001:db8:')
  );
}

const defaultLookup: HostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

async function resolveAddresses(url: URL, lookup: HostLookup): Promise<readonly string[]> {
  let addresses: readonly string[];
  try {
    addresses = await lookup(url.hostname);
  } catch (error) {
    throw new PlinthwayError(
      'NETWORK_DENIED',
      'MCP destination DNS resolution failed',
      { origin: url.origin },
      { cause: error },
    );
  }
  if (addresses.length === 0) throw denied(url, 'DNS returned no addresses');
  return addresses;
}

function createRestrictedDispatcher(allowedOrigins: readonly string[], lookup: HostLookup): Agent {
  const normalizedAllowlist = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  return new Agent({
    connect: (connectOptions, callback) => {
      const hostname = connectOptions.hostname.replace(/^\[|\]$/gu, '');
      const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
      const origin = new URL(`${connectOptions.protocol}//${host}:${connectOptions.port}`).origin;
      const guardedLookup: LookupFunction = (lookupHostname, dnsOptions, done) => {
        void lookup(lookupHostname).then(
          (addresses) => {
            try {
              if (addresses.length === 0) {
                throw denied(new URL(origin), 'DNS returned no addresses');
              }
              const resolvedLoopback = addresses.every(isLoopbackAddress);
              const permittedResolvedLoopback =
                resolvedLoopback &&
                (connectOptions.protocol === 'http:' || isLocalhostHostname(lookupHostname));
              if (connectOptions.protocol === 'http:' && !resolvedLoopback) {
                throw denied(
                  new URL(origin),
                  'HTTP aliases must resolve exclusively to loopback addresses',
                );
              }
              if (
                addresses.some(isPrivateAddress) &&
                !permittedResolvedLoopback &&
                !normalizedAllowlist.has(origin)
              ) {
                throw denied(new URL(origin), 'private or link-local address is not allowlisted');
              }
              const resolved = addresses.map((address) => ({
                address,
                family: isIP(address),
              }));
              const first = resolved[0];
              if (first === undefined || first.family === 0) {
                throw denied(new URL(origin), 'DNS returned an invalid address');
              }
              if (dnsOptions.all === true) done(null, resolved);
              else done(null, first.address, first.family);
            } catch (error) {
              done(error as NodeJS.ErrnoException, []);
            }
          },
          (error: unknown) => {
            done(
              new PlinthwayError(
                'NETWORK_DENIED',
                'MCP destination DNS resolution failed',
                { origin },
                { cause: error },
              ),
              [],
            );
          },
        );
      };
      buildConnector({ lookup: guardedLookup })(connectOptions, callback);
    },
  });
}

function restrictedNetworkError(error: unknown): unknown {
  if (error instanceof PlinthwayError) return error;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const cause = error.cause;
    if (cause instanceof PlinthwayError) return cause;
  }
  return error;
}

export async function assertAllowedMcpUrl(
  url: URL,
  allowedOrigins: readonly string[],
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  if (url.username.length > 0 || url.password.length > 0)
    throw denied(url, 'URL userinfo is forbidden');
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw denied(url, 'MCP endpoints must use HTTP or HTTPS');
  const normalizedAllowlist = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  if (loopback) return;
  const addresses = await resolveAddresses(url, lookup);
  const resolvedLoopback = addresses.every(isLoopbackAddress);
  if (url.protocol === 'http:') {
    if (resolvedLoopback) return;
    throw denied(url, 'HTTP aliases must resolve exclusively to loopback addresses');
  }
  if (
    addresses.some(isPrivateAddress) &&
    !(resolvedLoopback && isLocalhostHostname(url.hostname)) &&
    !normalizedAllowlist.has(url.origin)
  ) {
    throw denied(url, 'private or link-local address is not allowlisted');
  }
}

export async function assertAllowedPublicMcpUrl(
  url: URL,
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  if (url.username.length > 0 || url.password.length > 0)
    throw denied(url, 'URL userinfo is forbidden');
  if (url.protocol !== 'https:') throw denied(url, 'public MCP App origins must use HTTPS');
  if (isLoopbackHostname(url.hostname) || isLocalhostHostname(url.hostname)) {
    throw denied(url, 'loopback destinations are forbidden');
  }
  const addresses = await resolveAddresses(url, lookup);
  if (addresses.some(isPrivateAddress)) {
    throw denied(url, 'private or link-local destinations are forbidden');
  }
}

export interface RestrictedFetchOptions {
  readonly originalUrl: URL;
  readonly allowedOrigins: readonly string[];
  readonly lookup?: HostLookup;
  readonly fetch?: typeof globalThis.fetch;
  readonly credentialHeaderNames?: readonly string[];
  readonly credentialOrigins?: readonly string[];
  readonly isCredentialDestination?: (url: URL) => boolean;
}

export function createRestrictedFetch(options: RestrictedFetchOptions): typeof globalThis.fetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const lookup = options.lookup ?? defaultLookup;
  const dispatcher = createRestrictedDispatcher(options.allowedOrigins, lookup);
  const restrictedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let request = new Request(input, { ...init, redirect: 'manual' });
    const credentialHeaders = new Set([
      ...SENSITIVE_HEADERS,
      ...(options.credentialHeaderNames ?? []).map((header) => header.toLowerCase()),
    ]);
    const credentialOrigins = new Set([
      options.originalUrl.origin,
      ...(options.credentialOrigins ?? []).map((origin) => new URL(origin).origin),
    ]);
    for (let redirects = 0; ; redirects += 1) {
      const url = new URL(request.url);
      await assertAllowedMcpUrl(url, options.allowedOrigins, lookup);
      const isBasicClientAuthentication = request.headers
        .get('authorization')
        ?.startsWith('Basic ');
      if (
        !credentialOrigins.has(url.origin) &&
        !(isBasicClientAuthentication === true && options.isCredentialDestination?.(url) === true)
      ) {
        for (const header of credentialHeaders) request.headers.delete(header);
      }
      const replay = request.clone();
      const sensitiveBody = await hasSensitiveFormBody(replay.clone());
      let response: Response;
      try {
        response = await fetchImplementation(request, { dispatcher } as RequestInit & {
          readonly dispatcher: Agent;
        });
      } catch (error) {
        throw restrictedNetworkError(error);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (redirects >= 3) throw denied(url, 'redirect limit exceeded');
      const location = response.headers.get('location');
      if (location === null) throw denied(url, 'redirect omitted Location');
      const destination = new URL(location, url);
      await assertAllowedMcpUrl(destination, options.allowedOrigins, lookup);
      if (sensitiveBody && destination.origin !== url.origin) {
        throw denied(destination, 'credential-bearing form redirects may not change origin');
      }
      const headers = new Headers(replay.headers);
      const redirectsBasicClientAuthentication = headers.get('authorization')?.startsWith('Basic ');
      if (
        !credentialOrigins.has(destination.origin) &&
        !(
          redirectsBasicClientAuthentication === true &&
          options.isCredentialDestination?.(destination) === true
        )
      ) {
        for (const header of credentialHeaders) headers.delete(header);
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && replay.method === 'POST')
      ) {
        request = new Request(destination, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: replay.signal,
        });
      } else {
        request = new Request(destination, replay);
        for (const header of credentialHeaders) {
          if (!headers.has(header)) request.headers.delete(header);
        }
      }
    }
  };
  Object.defineProperty(restrictedFetch, RESTRICTED_FETCH_BRAND, { value: true });
  return restrictedFetch;
}
