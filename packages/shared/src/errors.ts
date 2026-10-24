import type { JsonValue } from './contracts.js';
import { redact } from './redaction.js';

export type PlinthwayErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_ENV_MISSING'
  | 'CONFIG_SECRET_INTERPOLATION'
  | 'CONFIG_ENV_SYNTAX'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_ACTIVE'
  | 'PROFILE_INVALID'
  | 'REGISTRY_UNAVAILABLE'
  | 'REGISTRY_INVALID'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_CONFIGURED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'ADAPTER_UNSUPPORTED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CREDENTIAL_MISSING'
  | 'AUTH_FAILED'
  | 'KEYRING_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'MCP_CONNECTION_FAILED'
  | 'MCP_PROTOCOL_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_ARGUMENTS_INVALID'
  | 'TOOL_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'NETWORK_DENIED'
  | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'STEP_LIMIT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CONFLICT'
  | 'STORAGE_CORRUPT'
  | 'STORAGE_ERROR';

export class PlinthwayError extends Error {
  readonly code: PlinthwayErrorCode;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(
    code: PlinthwayErrorCode,
    message: string,
    details: Record<string, JsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlinthwayError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: redact(this.message),
      details: redact(this.details),
    };
  }
}
