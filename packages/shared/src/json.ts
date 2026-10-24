import { createHash } from 'node:crypto';

import type { JsonValue } from './contracts.js';

function normalize(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError(`Sparse array item at ${path}[${String(index)}]`);
      }
      normalized.push(normalize(value[index], `${path}[${String(index)}]`));
    }
    return normalized;
  }

  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }

    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return normalized;
  }

  throw new TypeError(`Non-JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, '$'));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freezeRecursively(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    freezeRecursively(nested);
  }
  Object.freeze(value);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  freezeRecursively(copy);
  return copy;
}
