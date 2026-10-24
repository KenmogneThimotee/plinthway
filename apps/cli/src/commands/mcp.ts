import type { Command } from 'commander';

import { PlinthwayError, type JsonValue } from '@plinthway/shared';

import type { CliContext } from '../application.js';
import { requireService, writeRecord } from '../application.js';

function displayServer(serverId: string, label?: string): string {
  return label === undefined ? serverId : `${label} (${serverId})`;
}

const RESERVED_SERVER_IDS = new Set(['filesystem', 'shell']);

function serverIdSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function remoteServerId(label: string | undefined, rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new PlinthwayError(
      'CONFIG_INVALID',
      'MCP server configuration is invalid',
      { issues: [{ path: 'url', message: 'Invalid URL' }] },
      { cause: error },
    );
  }
  const endpoint = `${url.hostname}${url.port.length === 0 ? '' : `-${url.port}`}${url.pathname === '/' ? '' : `-${url.pathname}`}`;
  const candidate = serverIdSlug(label ?? '') || serverIdSlug(endpoint) || 'mcp-server';
  return /^[a-z]/u.test(candidate) && !RESERVED_SERVER_IDS.has(candidate)
    ? candidate
    : `mcp-${candidate}`;
}

export function registerMcpCommands(program: Command, context: CliContext): void {
  const mcp = program.command('mcp').description('inspect MCP server connections');
  mcp.hook('preAction', async (_command, actionCommand) => {
    if (!['add', 'connect', 'disconnect', 'label', 'remove'].includes(actionCommand.name())) {
      await context.application.prepareMcp();
    }
  });
  mcp
    .command('add [server] [stdioCommand...]')
    .description('add an MCP server to a profile')
    .option('--url <url>', 'Streamable HTTP MCP endpoint')
    .option('--label <label>', 'friendly display label')
    .option('--profile <id>', 'target profile (defaults to the selected profile)')
    .option('--force', 'replace an existing server with the same ID')
    .action(
      async (
        serverId: string | undefined,
        stdioCommand: string[],
        options: { url?: string; label?: string; profile?: string; force?: boolean },
        command: Command,
      ) => {
        if (serverId === undefined && options.url === undefined) {
          throw new PlinthwayError(
            'CONFIG_INVALID',
            'A stdio MCP server requires an explicit server ID and command after --',
          );
        }
        if (options.url === undefined && stdioCommand.length === 0) {
          throw new PlinthwayError(
            'CONFIG_INVALID',
            'Provide --url <url> or a stdio command after --',
          );
        }
        if (options.url !== undefined && stdioCommand.length > 0) {
          throw new PlinthwayError(
            'CONFIG_INVALID',
            'Choose either --url <url> or a stdio command, not both',
          );
        }
        const resolvedServerId =
          serverId ??
          (options.url === undefined ? undefined : remoteServerId(options.label, options.url));
        if (resolvedServerId === undefined) {
          throw new PlinthwayError('CONFIG_INVALID', 'MCP server ID could not be derived');
        }
        const selected =
          options.profile === undefined
            ? await context.application.initialize()
            : await context.application.getProfile(options.profile);
        if (selected === undefined) {
          throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
        }
        const extensions = {
          tasks: false,
          skills: false,
          apps: false,
          oauthClientCredentials: false,
          enterpriseManagedAuth: false,
        };
        const server =
          options.url === undefined
            ? {
                ...(options.label === undefined ? {} : { label: options.label }),
                transport: 'stdio' as const,
                command: stdioCommand[0] ?? '',
                args: stdioCommand.slice(1),
                env: [],
                extensions,
              }
            : {
                ...(options.label === undefined ? {} : { label: options.label }),
                transport: 'streamable-http' as const,
                url: options.url,
                auth: { mode: 'oauth' as const, scopes: [] },
                extensions,
              };
        await context.application.addMcpServer(selected.id, resolvedServerId, server, {
          replace: options.force === true,
        });
        const status = (await context.application.listMcpServers(selected.id)).find(
          (entry) => entry.serverId === resolvedServerId,
        );
        const enabled = status?.enabled ?? false;
        const storedServer =
          status?.label === undefined ? server : { ...server, label: status.label };
        const displayName = displayServer(resolvedServerId, status?.label ?? options.label);
        writeRecord(
          context,
          command,
          {
            profileId: selected.id,
            serverId: resolvedServerId,
            ...(status?.label === undefined && options.label === undefined
              ? {}
              : { label: status?.label ?? options.label }),
            server: storedServer,
            enabled,
          },
          enabled
            ? `Updated enabled MCP server ${displayName} in profile ${selected.id}`
            : `Added MCP server ${displayName} to profile ${selected.id}. Run plinthway mcp connect ${resolvedServerId} --profile ${selected.id} to connect it.`,
        );
      },
    );
  const selectProfile = async (profileId?: string) => {
    const selected =
      profileId === undefined
        ? await context.application.initialize()
        : await context.application.getProfile(profileId);
    if (selected === undefined) {
      throw new PlinthwayError('PROFILE_NOT_FOUND', 'No profile is selected');
    }
    return selected;
  };
  mcp
    .command('label <server> [label]')
    .description('set or clear an MCP server display label')
    .option('--clear', 'remove the display label')
    .option('--profile <id>', 'target profile (defaults to the selected profile)')
    .action(
      async (
        serverId: string,
        label: string | undefined,
        options: { clear?: boolean; profile?: string },
        command: Command,
      ) => {
        if (label === undefined && options.clear !== true) {
          throw new PlinthwayError('CONFIG_INVALID', 'Provide a label or use --clear');
        }
        if (label !== undefined && options.clear === true) {
          throw new PlinthwayError('CONFIG_INVALID', 'Choose either a label or --clear');
        }
        const selected = await selectProfile(options.profile);
        await context.application.setMcpServerLabel(
          selected.id,
          serverId,
          options.clear === true ? undefined : label,
        );
        const status = (await context.application.listMcpServers(selected.id)).find(
          (entry) => entry.serverId === serverId,
        );
        const result = {
          profileId: selected.id,
          serverId,
          ...(status?.label === undefined ? {} : { label: status.label }),
        };
        writeRecord(
          context,
          command,
          result,
          options.clear === true
            ? `Cleared label for MCP server ${serverId} in profile ${selected.id}`
            : `Labeled MCP server ${displayServer(serverId, status?.label)} in profile ${selected.id}`,
        );
      },
    );
  const setConnection =
    (enabled: boolean) =>
    async (serverId: string, options: { profile?: string }, command: Command): Promise<void> => {
      const selected = await selectProfile(options.profile);
      await context.application.setMcpServerEnabled(selected.id, serverId, enabled);
      await context.application.prepareMcp(selected.id);
      let status = (await context.application.listMcpServers(selected.id)).find(
        (entry) => entry.serverId === serverId,
      );
      if (enabled && status?.state === 'auth-required') {
        const authorization = await requireService(context.application.mcp, 'MCP').authorize(
          serverId,
        );
        await authorization.waitForCompletion?.(context.signal);
        status = (await context.application.listMcpServers(selected.id)).find(
          (entry) => entry.serverId === serverId,
        );
      }
      if (enabled && status?.state !== 'ready') {
        const state = status?.state ?? 'disconnected';
        throw new PlinthwayError(
          'MCP_CONNECTION_FAILED',
          `MCP server ${serverId} did not become ready (${state})`,
          {
            profileId: selected.id,
            serverId,
            state,
            reason: status?.lastError?.code ?? 'status_unavailable',
          },
        );
      }
      writeRecord(
        context,
        command,
        status ?? { profileId: selected.id, serverId, enabled, state: 'disconnected' },
        enabled
          ? `Enabled MCP server ${serverId} for profile ${selected.id} (${status?.state ?? 'disconnected'})`
          : `Disconnected MCP server ${serverId} from profile ${selected.id}`,
      );
    };
  mcp
    .command('connect <server>')
    .description('persistently enable and connect an MCP server')
    .option('--profile <id>', 'target profile (defaults to the selected profile)')
    .action(setConnection(true));
  mcp
    .command('disconnect <server>')
    .description('persistently disable and disconnect an MCP server')
    .option('--profile <id>', 'target profile (defaults to the selected profile)')
    .action(setConnection(false));
  mcp
    .command('remove <server>')
    .description('remove an MCP server from a profile')
    .option('--profile <id>', 'target profile (defaults to the selected profile)')
    .action(async (serverId: string, options: { profile?: string }, command: Command) => {
      const selected = await selectProfile(options.profile);
      await context.application.removeMcpServer(selected.id, serverId);
      await context.application.prepareMcp(selected.id);
      writeRecord(
        context,
        command,
        { profileId: selected.id, serverId, removed: true },
        `Removed MCP server ${serverId} from profile ${selected.id}`,
      );
    });
  mcp.command('list').action(async (_options, command: Command) => {
    requireService(context.application.mcp, 'MCP');
    const statuses = await context.application.listMcpServers();
    writeRecord(
      context,
      command,
      statuses,
      statuses
        .map(
          (status) =>
            `${displayServer(status.serverId, status.label)}\t${status.state}\t${status.enabled ? (status.authorization?.state ?? 'unknown') : 'disabled'}`,
        )
        .join('\n'),
    );
  });
  mcp.command('test <server>').action((server: string, _options, command: Command) => {
    const status = requireService(context.application.mcp, 'MCP')
      .status()
      .find((entry) => entry.serverId === server);
    if (status?.state !== 'ready') {
      throw new PlinthwayError('MCP_CONNECTION_FAILED', `MCP server ${server} is not ready`);
    }
    writeRecord(context, command, status, `${server}: ready`);
  });
  mcp
    .command('prompts')
    .description('list available MCP prompts')
    .action((_options, command: Command) => {
      const prompts = requireService(context.application.mcp, 'MCP').listPrompts();
      writeRecord(
        context,
        command,
        prompts,
        prompts.map((prompt) => `${prompt.name}\t${prompt.description ?? ''}`).join('\n'),
      );
    });
  mcp
    .command('resources')
    .description('list available MCP resources')
    .action((_options, command: Command) => {
      const resources = requireService(context.application.mcp, 'MCP').listResources();
      writeRecord(
        context,
        command,
        resources,
        resources
          .map((resource) => `${resource.serverId}\t${resource.uri}\t${resource.name}`)
          .join('\n'),
      );
    });
  mcp
    .command('skills')
    .description('list MCP-served skills')
    .action((_options, command: Command) => {
      const skills = requireService(context.application.mcp, 'MCP').listSkills();
      writeRecord(
        context,
        command,
        skills,
        skills
          .map(
            (skill) =>
              `${skill.serverId}\t${skill.uri}\t${skill.frontmatter.name}\t${skill.frontmatter.description}`,
          )
          .join('\n'),
      );
    });
  mcp
    .command('apps')
    .description('list sandboxed MCP Apps')
    .action((_options, command: Command) => {
      const apps = requireService(context.application.mcp, 'MCP').listApps();
      writeRecord(
        context,
        command,
        apps,
        apps.map((app) => `${app.qualifiedName}\t${app.resourceUri}`).join('\n'),
      );
    });
  const app = mcp.command('app').description('open and close sandboxed MCP Apps');
  app.command('open <tool>').action(async (tool: string, _options, command: Command) => {
    const auditSession = await context.application.newSession();
    const session = await requireService(context.application.mcp, 'MCP').openApp(tool, {
      auditSessionId: auditSession.id,
    });
    const result = {
      id: session.id,
      tool: session.descriptor.qualifiedName,
      url: session.url,
      origin: session.origin,
      proxyOrigin: session.proxyOrigin,
    };
    writeRecord(context, command, result, `${session.id}\t${session.url}`);
    await session.waitUntilClosed(context.signal);
  });
  const skill = mcp.command('skill').description('inspect and activate MCP-served skills');
  skill
    .command('get <server> <uri>')
    .action(async (server: string, uri: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').getSkill(server, uri);
      writeRecord(context, command, result, `${server}\t${uri}\t${result.frontmatter.name}`);
    });
  skill
    .command('activate <server> <uri>')
    .action(async (server: string, uri: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').activateSkill(
        server,
        uri,
        { requestedBy: 'user' },
      );
      writeRecord(context, command, result, `${server}\t${uri}\tactive`);
    });
  skill
    .command('deactivate <server> <uri>')
    .action((server: string, uri: string, _options, command: Command) => {
      requireService(context.application.mcp, 'MCP').deactivateSkill(server, uri);
      writeRecord(
        context,
        command,
        { serverId: server, uri, active: false },
        `${server}\t${uri}\tinactive`,
      );
    });
  skill
    .command('read <server> <skillUri> <path>')
    .action(async (server: string, skillUri: string, path: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').readSkill(
        server,
        skillUri,
        path,
      );
      writeRecord(context, command, result, result.bytes.toString('utf8'));
    });
  skill
    .command('directory <server> <skillUri> <path>')
    .action(async (server: string, skillUri: string, path: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').readSkillDirectory(
        server,
        skillUri,
        path,
      );
      writeRecord(
        context,
        command,
        result,
        result.map((entry) => `${entry.uri}\t${entry.mimeType ?? ''}`).join('\n'),
      );
    });
  mcp
    .command('logs [server]')
    .description('show bounded MCP host events')
    .action((server: string | undefined, _options, command: Command) => {
      const events = requireService(context.application.mcp, 'MCP').listEvents(server);
      writeRecord(
        context,
        command,
        events,
        events.map((event) => `${event.serverId}\t${event.type}`).join('\n'),
      );
    });
  mcp
    .command('prompt <name>')
    .description('invoke an MCP prompt explicitly')
    .option('--arguments <json>', 'prompt string arguments as JSON', '{}')
    .action(async (name: string, options: { arguments: string }, command: Command) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(options.arguments) as unknown;
      } catch (error) {
        throw new PlinthwayError(
          'CONFIG_INVALID',
          'MCP prompt arguments must be valid JSON',
          {},
          { cause: error },
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PlinthwayError('CONFIG_INVALID', 'MCP prompt arguments must be an object');
      }
      const argumentsValue: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
          throw new PlinthwayError('CONFIG_INVALID', 'MCP prompt arguments must be strings');
        }
        argumentsValue[key] = value;
      }
      const result = await requireService(context.application.mcp, 'MCP').getPrompt(
        name,
        argumentsValue,
        { timeoutMs: 30_000, ...(context.signal === undefined ? {} : { signal: context.signal }) },
      );
      writeRecord(context, command, result, `${result.serverId}\t${result.promptName}`);
    });
  mcp
    .command('resource <server> <uri>')
    .description('read an MCP resource explicitly')
    .action(async (server: string, uri: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').readResource(
        server,
        uri,
        { timeoutMs: 30_000, ...(context.signal === undefined ? {} : { signal: context.signal }) },
      );
      writeRecord(context, command, result, `${server}\t${uri}`);
    });
  mcp
    .command('auth <server>')
    .description('start or finish MCP OAuth authorization')
    .option('--code <code>', 'authorization callback code')
    .option('--state <state>', 'authorization callback state')
    .option('--issuer <issuer>', 'authorization callback issuer')
    .option('--scope <scope>', 'required scope for step-up authorization')
    .action(
      async (
        server: string,
        options: { code?: string; state?: string; issuer?: string; scope?: string },
        command: Command,
      ) => {
        const result = await requireService(context.application.mcp, 'MCP').authorize(server, {
          ...(options.code === undefined ? {} : { code: options.code }),
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
          ...(options.scope === undefined ? {} : { requiredScope: options.scope }),
        });
        writeRecord(
          context,
          command,
          result,
          result.state === 'authorized'
            ? `${server}: authorized`
            : `${server}: open ${result.authorizationUrl ?? ''}`,
        );
        if (result.state === 'redirect') {
          await result.waitForCompletion?.(context.signal);
        }
      },
    );

  mcp
    .command('tasks')
    .description('list durable MCP tasks for the active profile generation')
    .action(async (_options, command: Command) => {
      const tasks = await requireService(context.application.mcp, 'MCP').listTasks();
      writeRecord(
        context,
        command,
        tasks,
        tasks
          .map(
            (task) =>
              `${task.serverId}\t${task.reference.taskId}\t${task.status}\t${task.toolName}`,
          )
          .join('\n'),
      );
    });
  const task = mcp.command('task').description('create or control a durable MCP task');
  task
    .command('start <tool>')
    .option('--arguments <json>', 'tool arguments as JSON', '{}')
    .action(async (tool: string, options: { arguments: string }, command: Command) => {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(options.arguments) as unknown;
      } catch (error) {
        throw new PlinthwayError(
          'CONFIG_INVALID',
          'MCP task arguments must be valid JSON',
          {},
          { cause: error },
        );
      }
      const result = await requireService(context.application.mcp, 'MCP').startTask(
        tool,
        argumentsValue,
        { timeoutMs: 30_000, ...(context.signal === undefined ? {} : { signal: context.signal }) },
      );
      writeRecord(
        context,
        command,
        result,
        result.kind === 'task'
          ? `${result.task.serverId}\t${result.task.reference.taskId}\t${result.task.status}`
          : `${result.result.serverId}\timmediate`,
      );
    });
  task
    .command('status <server> <taskId>')
    .action(async (server: string, taskId: string, _options, command: Command) => {
      const result = await requireService(context.application.mcp, 'MCP').getTask(server, taskId, {
        timeoutMs: 30_000,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      writeRecord(context, command, result, `${server}\t${taskId}\t${result.status}`);
    });
  task
    .command('update <server> <taskId>')
    .requiredOption('--responses <json>', 'input responses keyed by request ID')
    .action(
      async (server: string, taskId: string, options: { responses: string }, command: Command) => {
        let responses: unknown;
        try {
          responses = JSON.parse(options.responses) as unknown;
        } catch (error) {
          throw new PlinthwayError(
            'CONFIG_INVALID',
            'MCP task responses must be valid JSON',
            {},
            { cause: error },
          );
        }
        if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
          throw new PlinthwayError('CONFIG_INVALID', 'MCP task responses must be an object');
        }
        const result = await requireService(context.application.mcp, 'MCP').updateTask(
          server,
          taskId,
          responses as Readonly<Record<string, JsonValue>>,
          {
            timeoutMs: 30_000,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
        );
        writeRecord(context, command, result, `${server}\t${taskId}\t${result.status}`);
      },
    );
  task
    .command('cancel <server> <taskId>')
    .action(async (server: string, taskId: string, _options, command: Command) => {
      await requireService(context.application.mcp, 'MCP').cancelTask(server, taskId, {
        timeoutMs: 30_000,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      writeRecord(
        context,
        command,
        { serverId: server, taskId, status: 'cancelled' },
        `${server}\t${taskId}\tcancelled`,
      );
    });
}
