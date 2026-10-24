import { Text } from 'ink';
import type {
  McpHostEvent,
  McpInteractionRequest,
  McpPrompt,
  McpPersistedTask,
  McpResource,
  McpSkill,
  McpActiveSkill,
  McpAppDescriptor,
  AppSession,
} from '@plinthway/mcp-client';
import type { ConfiguredMcpServerStatus } from '@plinthway/app-core';

import { OverlayFrame } from './frame.js';

export interface McpOverlayProps {
  readonly statuses: readonly ConfiguredMcpServerStatus[];
  readonly prompts?: readonly McpPrompt[];
  readonly resources?: readonly McpResource[];
  readonly events?: readonly McpHostEvent[];
  readonly interactions?: readonly McpInteractionRequest[];
  readonly tasks?: readonly McpPersistedTask[];
  readonly skills?: readonly McpSkill[];
  readonly activeSkills?: readonly McpActiveSkill[];
  readonly apps?: readonly McpAppDescriptor[];
  readonly appSessions?: readonly AppSession[];
  readonly selectedServer?: number;
  readonly selectedInteraction?: number;
  readonly responseDraft?: string;
}

export function mcpInteractionNeedsResponse(interaction: McpInteractionRequest): boolean {
  if (interaction.method === 'sampling/createMessage') return true;
  if (interaction.method !== 'elicitation/create') return false;
  if (
    interaction.params === null ||
    typeof interaction.params !== 'object' ||
    Array.isArray(interaction.params)
  )
    return true;
  return (interaction.params as Readonly<Record<string, unknown>>).mode !== 'url';
}

export function mcpServerNeedsConnection(status: ConfiguredMcpServerStatus): boolean {
  return !status.enabled || status.state === 'auth-required';
}

function displayServer(status: ConfiguredMcpServerStatus): string {
  return status.label === undefined ? status.serverId : `${status.label} (${status.serverId})`;
}

export function McpOverlay({
  statuses,
  prompts = [],
  resources = [],
  events = [],
  interactions = [],
  tasks = [],
  skills = [],
  activeSkills = [],
  apps = [],
  appSessions = [],
  selectedServer = 0,
  selectedInteraction = 0,
  responseDraft = '',
}: McpOverlayProps) {
  const serverSelectionActive = interactions.length === 0;
  const selectedStatus = serverSelectionActive ? statuses[selectedServer] : undefined;
  return (
    <OverlayFrame title="MCP servers">
      {statuses.length === 0 ? (
        <Text>No MCP servers configured.</Text>
      ) : (
        statuses.flatMap((status, index) => [
          <Text
            key={`${status.serverId}:status`}
            {...(serverSelectionActive && index === selectedServer
              ? { color: 'yellow' as const }
              : {})}
          >
            {serverSelectionActive && index === selectedServer ? '› ' : '  '}
            {displayServer(status)} · {status.state}
            {status.authorization?.state === 'required'
              ? ` · ${status.authorization.reason ?? 'authorization required'}`
              : ''}
          </Text>,
          ...(status.deprecationWarnings ?? []).map((warning) => (
            <Text key={`${status.serverId}:${warning}`} color="yellow">
              {warning}
            </Text>
          )),
        ])
      )}
      {prompts.map((prompt) => (
        <Text key={`prompt:${prompt.name}`}>prompt · {prompt.name}</Text>
      ))}
      {resources.map((resource) => (
        <Text key={`resource:${resource.serverId}:${resource.uri}`}>
          resource · {resource.serverId} · {resource.uri}
        </Text>
      ))}
      {skills.map((skill) => (
        <Text key={`skill:${skill.serverId}:${skill.uri}`}>
          skill · {skill.serverId} · {skill.frontmatter.name} ·{' '}
          {activeSkills.some(
            (active) => active.serverId === skill.serverId && active.uri === skill.uri,
          )
            ? 'active'
            : 'inactive'}
        </Text>
      ))}
      {apps.map((app) => (
        <Text key={`app:${app.qualifiedName}`}>
          app · {app.qualifiedName} · {app.resourceUri}
        </Text>
      ))}
      {appSessions.map((session) => (
        <Text key={`app-session:${session.id}`} color="cyan">
          app open · {session.id} · {session.descriptor.qualifiedName} · {session.url}
        </Text>
      ))}
      {events.slice(-5).map((event, index) => (
        <Text key={`event:${String(index)}:${event.serverId}`} dimColor>
          {event.serverId} · {event.type}
          {event.type === 'logging' ? ` · ${event.level}` : ''}
        </Text>
      ))}
      {tasks.map((task) => (
        <Text key={`task:${task.serverId}:${task.reference.taskId}`}>
          task · {task.serverId} · {task.reference.taskId} · {task.status} · {task.toolName}
        </Text>
      ))}
      {interactions.map((interaction, index) => (
        <Text
          key={interaction.id}
          {...(index === selectedInteraction ? { color: 'yellow' as const } : {})}
        >
          {index === selectedInteraction ? '> ' : '  '}
          {interaction.serverId} requests {interaction.method}
          {interaction.deprecated ? ' (deprecated)' : ''} · {JSON.stringify(interaction.params)}
        </Text>
      ))}
      {interactions[selectedInteraction] !== undefined &&
        (mcpInteractionNeedsResponse(interactions[selectedInteraction]) ? (
          <>
            <Text>Response JSON: {responseDraft}</Text>
            <Text>[Enter] Approve response [D] Decline [X] Cancel</Text>
          </>
        ) : (
          <Text>[A] Approve [D] Decline [X] Cancel</Text>
        ))}
      {interactions.length === 0 && selectedStatus !== undefined && (
        <Text dimColor>
          ↑/↓ Select server · [Enter]{' '}
          {mcpServerNeedsConnection(selectedStatus)
            ? 'Connect selected server'
            : 'Disconnect selected server'}
        </Text>
      )}
      <Text dimColor>Configured servers remain disconnected until explicitly enabled.</Text>
      <Text dimColor>/mcp connect &lt;server&gt; · /mcp disconnect &lt;server&gt;</Text>
      <Text dimColor>/mcp open &lt;tool&gt; · /mcp close &lt;session&gt;</Text>
    </OverlayFrame>
  );
}
