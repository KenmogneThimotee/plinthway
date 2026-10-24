import { createHash } from 'node:crypto';

import { PlinthwayError } from '@plinthway/shared';

function safe(value: string, prefix: string, maxLength: number): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^([^A-Za-z_])/u, '_$1');
  const base = normalized.length === 0 ? prefix : normalized;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${prefix}_${base.slice(0, Math.max(1, maxLength - prefix.length - digest.length - 2))}_${digest}`;
}

export class ChatGptToolMap {
  readonly #aliases = new Map<string, string>();
  readonly #originals = new Map<string, string>();

  constructor(names: readonly string[]) {
    for (const name of [...new Set(names)].sort((left, right) => left.localeCompare(right))) {
      let alias = safe(name, 'tool', 64);
      let collision = 1;
      while (this.#originals.has(alias) && this.#originals.get(alias) !== name) {
        alias = `${safe(name, 'tool', 59)}_${String(collision)}`;
        collision += 1;
      }
      this.#aliases.set(name, alias);
      this.#originals.set(alias, name);
    }
  }

  alias(originalName: string): string {
    const alias = this.#aliases.get(originalName);
    if (alias === undefined) {
      throw new PlinthwayError(
        'TOOL_NOT_FOUND',
        `Tool ${originalName} was not included in this request`,
      );
    }
    return alias;
  }

  originalName(alias: string): string {
    const original = this.#originals.get(alias);
    if (original === undefined) {
      throw new PlinthwayError(
        'TOOL_NOT_FOUND',
        'Provider returned an unknown ChatGPT tool alias',
        {
          alias,
        },
      );
    }
    return original;
  }

  namespace(originalName: string): string {
    const segment = originalName.split('.')[0] ?? 'local';
    const normalized = segment.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^([^A-Za-z_])/u, '_$1');
    return (normalized.length === 0 ? 'local' : normalized).slice(0, 64);
  }
}
