import { Box, Text } from 'ink';

import type { TuiPhase } from '../reducer.js';

export interface HeaderProps {
  readonly profile?: string;
  readonly model?: string;
  readonly mcpHealth: string;
  readonly phase: TuiPhase;
  readonly narrow: boolean;
}

export function Header({ profile, model, mcpHealth, phase, narrow }: HeaderProps) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        plinthway
      </Text>
      <Text>
        profile: <Text bold>{profile ?? 'none'}</Text>
        {!narrow && (
          <>
            {' '}
            · model: {model ?? 'unselected'} · mcp: {mcpHealth}
          </>
        )}
        {' · '}
        <Text
          color={
            phase === 'error'
              ? 'red'
              : phase === 'running' || phase === 'updating-mcp'
                ? 'yellow'
                : 'green'
          }
        >
          {phase}
        </Text>
      </Text>
    </Box>
  );
}
