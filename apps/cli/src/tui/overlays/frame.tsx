import type { ReactNode } from 'react';
import { Box, Text } from 'ink';

export function OverlayFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {title}
      </Text>
      {children}
      <Text dimColor>Esc closes</Text>
    </Box>
  );
}
