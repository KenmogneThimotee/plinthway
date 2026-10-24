import type { Command } from 'commander';

import { asSessionId } from '@plinthway/shared';

import type { CliContext } from '../application.js';
import { writeRecord } from '../application.js';

export function registerSessionCommands(program: Command, context: CliContext): void {
  const sessions = program.command('sessions').description('inspect durable sessions');
  sessions.command('list').action(async (_options, command: Command) => {
    const values = await context.application.listSessions();
    writeRecord(
      context,
      command,
      values,
      values.map((session) => `${session.id}\t${session.profile.id}\t${session.status}`).join('\n'),
    );
  });
  sessions.command('resume <id>').action(async (id: string, _options, command: Command) => {
    const result = await context.application.resumeSession(asSessionId(id));
    writeRecord(context, command, result, `${id}: ${result.status}`);
  });
  sessions
    .command('branch <id>')
    .requiredOption('--profile <id>')
    .action(async (id: string, options: { profile: string }, command: Command) => {
      const child = await context.application.branchSession(asSessionId(id), {
        profileId: options.profile,
      });
      writeRecord(context, command, child, child.id);
    });
}
