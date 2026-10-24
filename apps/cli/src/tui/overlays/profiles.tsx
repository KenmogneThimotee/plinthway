import { Text } from 'ink';
import type { WorkProfile } from '@plinthway/shared';

import { OverlayFrame } from './frame.js';

export function ProfilesOverlay({
  profiles,
  selected,
}: {
  readonly profiles: readonly WorkProfile[];
  readonly selected: number;
}) {
  return (
    <OverlayFrame title="Profiles — ↑/↓ select, Enter activate">
      {profiles.length === 0 ? (
        <Text>No profiles. Use /profile new to begin onboarding.</Text>
      ) : (
        profiles.map((profile, index) => (
          <Text key={profile.id} {...(index === selected ? { color: 'cyan' as const } : {})}>
            {index === selected ? '›' : ' '} {profile.name} ({profile.id}) ·{' '}
            {profile.model.primary ?? 'no model'} · {String(profile.mcp?.enabled.length ?? 0)} MCP
          </Text>
        ))
      )}
    </OverlayFrame>
  );
}
