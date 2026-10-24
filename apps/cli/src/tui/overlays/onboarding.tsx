import { Text } from 'ink';

import { OverlayFrame } from './frame.js';

export function OnboardingOverlay() {
  return (
    <OverlayFrame title="Welcome">
      <Text>The selected profile exists and chat is ready.</Text>
      <Text>Use /provider to configure a provider, API key, and model here.</Text>
      <Text dimColor>Escape dismisses setup; an unconfigured prompt is preserved for retry.</Text>
    </OverlayFrame>
  );
}
