import { Box, Text } from 'ink';

export function Status({
  sessionId,
  narrow,
}: {
  readonly sessionId?: string;
  readonly narrow: boolean;
}) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        {narrow
          ? 'Enter send · Wheel/PgUp/PgDn scroll · ^C cancel/exit'
          : 'Enter send · ⇧Enter newline · / commands · Wheel/PgUp/PgDn scroll · ^C cancel'}
      </Text>
      {!narrow && <Text dimColor>session: {sessionId ?? 'new'}</Text>}
    </Box>
  );
}
