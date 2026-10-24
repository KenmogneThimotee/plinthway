import { Box, Text } from 'ink';

import type { TuiPhase } from '../reducer.js';

export function Composer({ value, phase }: { readonly value: string; readonly phase: TuiPhase }) {
  return (
    <Box borderStyle="single" borderColor={phase === 'error' ? 'red' : 'gray'} paddingX={1}>
      <Text color="green">› </Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  );
}
