const REDACTED = '[REDACTED]';
const SECRET_KEY = /authorization|token|secret|password|api[-_]?key|cookie/i;
const registeredSecrets = new Map<string, number>();

export function isSecretKey(key: string): boolean {
  if (key === 'inputTokens' || key === 'outputTokens') return false;
  return SECRET_KEY.test(key);
}

export function registerRedactionSecret(secret: string): () => void {
  if (secret.length === 0) {
    throw new TypeError('Cannot register an empty redaction secret');
  }
  registeredSecrets.set(secret, (registeredSecrets.get(secret) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const count = registeredSecrets.get(secret) ?? 0;
    if (count <= 1) registeredSecrets.delete(secret);
    else registeredSecrets.set(secret, count - 1);
  };
}

function redactString(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length > 0) output = output.split(secret).join(REDACTED);
  }
  return output;
}

export function redact(value: unknown, extraSecrets: readonly string[] = []): unknown {
  const secrets = [...new Set([...registeredSecrets.keys(), ...extraSecrets])].sort(
    (left, right) => right.length - left.length,
  );
  const seen = new WeakMap<object, unknown>();

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') return redactString(current, secrets);
    if (typeof current !== 'object' || current === null) return current;
    const previous = seen.get(current);
    if (previous !== undefined) return previous;

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(visit(item));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, nested] of Object.entries(current)) {
      result[key] = isSecretKey(key) ? REDACTED : visit(nested);
    }
    return result;
  };

  return visit(value);
}
