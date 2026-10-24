import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { canonicalJson, PlinthwayError, type JsonValue } from '@plinthway/shared';

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_PROPERTIES = 1_000;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

function schemaMetrics(value: unknown): { readonly depth: number; readonly properties: number } {
  if (value === null || typeof value !== 'object') return { depth: 0, properties: 0 };
  const values = Array.isArray(value) ? value : Object.values(value);
  let depth = 0;
  let properties =
    !Array.isArray(value) && 'properties' in value && typeof value.properties === 'object'
      ? Object.keys(value.properties ?? {}).length
      : 0;
  for (const child of values) {
    const metrics = schemaMetrics(child);
    depth = Math.max(depth, metrics.depth + 1);
    properties += metrics.properties;
  }
  return { depth, properties };
}

function invalidSchema(
  serverId: string,
  toolName: string,
  message: string,
  cause?: unknown,
): PlinthwayError {
  return new PlinthwayError(
    'MCP_PROTOCOL_ERROR',
    `MCP server ${serverId} supplied an invalid schema for ${toolName}: ${message}`,
    { serverId, toolName },
    cause === undefined ? undefined : { cause },
  );
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

export type ToolArgumentValidator = (argumentsValue: unknown) => JsonValue;

export function compileToolValidator(
  serverId: string,
  toolName: string,
  schema: unknown,
): ToolArgumentValidator {
  let serialized: string;
  try {
    serialized = canonicalJson(schema);
  } catch (error) {
    throw invalidSchema(serverId, toolName, 'schema is not JSON', error);
  }
  const metrics = schemaMetrics(schema);
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw invalidSchema(serverId, toolName, 'schema exceeds 256 KiB');
  }
  if (metrics.depth > MAX_SCHEMA_DEPTH) {
    throw invalidSchema(serverId, toolName, 'schema exceeds maximum depth');
  }
  if (metrics.properties > MAX_SCHEMA_PROPERTIES) {
    throw invalidSchema(serverId, toolName, 'schema exceeds maximum property count');
  }

  let compiled: ValidateFunction;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('type' in parsed) ||
      parsed.type !== 'object'
    ) {
      throw new TypeError('MCP input schemas must describe an object');
    }
    const dialect = '$schema' in parsed ? parsed.$schema : undefined;
    const ajv =
      dialect === 'https://json-schema.org/draft/2020-12/schema'
        ? new Ajv2020({ allErrors: true, strict: true })
        : new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(parsed);
  } catch (error) {
    throw invalidSchema(serverId, toolName, 'schema compilation failed', error);
  }

  return (argumentsValue: unknown): JsonValue => {
    let normalized: JsonValue;
    try {
      normalized = JSON.parse(canonicalJson(argumentsValue)) as JsonValue;
    } catch (error) {
      throw new PlinthwayError(
        'TOOL_ARGUMENTS_INVALID',
        `Arguments for ${serverId}.${toolName} are not valid JSON`,
        { serverId, toolName },
        { cause: error },
      );
    }
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new PlinthwayError(
        'TOOL_ARGUMENTS_INVALID',
        `Arguments for ${serverId}.${toolName} must be a JSON object`,
        { serverId, toolName },
      );
    }
    if (!compiled(normalized)) {
      throw new PlinthwayError(
        'TOOL_ARGUMENTS_INVALID',
        `Arguments for ${serverId}.${toolName} failed validation`,
        { serverId, toolName, validation: formatErrors(compiled.errors) },
      );
    }
    return normalized;
  };
}
