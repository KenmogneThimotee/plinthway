import { Text } from 'ink';
import { canonicalJson } from '@plinthway/shared';

import type { ApprovalView } from '../reducer.js';
import { OverlayFrame } from './frame.js';

export function ApprovalOverlay({ approval }: { readonly approval: ApprovalView }) {
  return (
    <OverlayFrame title="Tool approval required">
      <Text>server: {approval.serverId}</Text>
      <Text>tool: {approval.toolName}</Text>
      <Text>arguments: {canonicalJson(approval.arguments)}</Text>
      <Text>targets: {approval.targets?.join(', ') ?? 'none detected'}</Text>
      <Text>read-only hint: {approval.readOnlyHint === true ? 'yes' : 'no'}</Text>
      <Text>anticipated side effects: {approval.sideEffects ?? 'unknown'}</Text>
      <Text color="yellow">
        {approval.submitting === true ? 'Persisting decision…' : '[A] Allow once   [D] Deny'}
      </Text>
    </OverlayFrame>
  );
}
