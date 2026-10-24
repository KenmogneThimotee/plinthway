import { Text } from 'ink';

import { OverlayFrame } from './frame.js';

export function AuthOverlay() {
  return (
    <OverlayFrame title="Provider authentication">
      <Text>
        Provider credentials are scoped to this profile and stored only in the OS keyring.
      </Text>
      <Text>Use /auth or /provider, then retry your preserved prompt.</Text>
    </OverlayFrame>
  );
}
