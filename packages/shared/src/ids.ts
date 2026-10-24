import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type ProfileId = Brand<string, 'ProfileId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type EventId = Brand<string, 'EventId'>;

const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function asProfileId(value: string): ProfileId {
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError(
      'Profile IDs must be lowercase alphanumeric slugs separated by single hyphens',
    );
  }
  return value as ProfileId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

export function asExecutionId(value: string): ExecutionId {
  return value as ExecutionId;
}

export function newExecutionId(): ExecutionId {
  return randomUUID() as ExecutionId;
}

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function newEventId(): EventId {
  return randomUUID() as EventId;
}
