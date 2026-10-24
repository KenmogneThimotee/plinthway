import type { Command } from 'commander';

import type { CliContext } from '../application.js';
import { jsonMode } from '../application.js';

export function registerRunCommand(program: Command, context: CliContext): void {
  program
    .command('run <prompt>')
    .description('run one prompt in a new session')
    .option('--profile <id>')
    .action(async (prompt: string, options: { profile?: string }, command: Command) => {
      const run = await context.application.run(prompt, {
        ...(options.profile === undefined ? {} : { profileId: options.profile }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (jsonMode(command)) {
        context.stdout.write(`${JSON.stringify({ type: 'session', sessionId: run.session.id })}\n`);
      }
      for await (const event of run.events) {
        if (jsonMode(command)) context.stdout.write(`${JSON.stringify(event)}\n`);
        else if (event.type === 'text-delta') context.stdout.write(event.text);
        else if (event.type === 'finish') context.stderr.write(`finish: ${event.reason}\n`);
      }
      if (!jsonMode(command)) context.stdout.write('\n');
    });
}
