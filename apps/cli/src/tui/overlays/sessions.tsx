import { Text } from 'ink';
import type { StoredSession } from '@plinthway/sessions';

import { OverlayFrame } from './frame.js';

export function SessionsOverlay({
  sessions,
  selected,
}: {
  readonly sessions: readonly StoredSession[];
  readonly selected: number;
}) {
  return (
    <OverlayFrame title="Sessions — ↑/↓ select, Enter resume snapshot">
      {sessions.length === 0 ? (
        <Text>No durable sessions.</Text>
      ) : (
        sessions.map((session, index) => (
          <Text key={session.id} {...(index === selected ? { color: 'cyan' as const } : {})}>
            {index === selected ? '›' : ' '} {session.id} · {session.profile.id} · {session.status}
          </Text>
        ))
      )}
    </OverlayFrame>
  );
}
