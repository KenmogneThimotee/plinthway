import type { Command } from 'commander';

import type { CliContext } from '../application.js';
import { writeRecord } from '../application.js';

export function registerInitCommand(program: Command, context: CliContext): void {
  program
    .command('init')
    .description('initialize local plinthway directories and configuration')
    .option('--force', 'replace the existing default configuration')
    .action(async (options: { force?: boolean }, command: Command) => {
      await context.initializeHome(options.force === true);
      writeRecord(context, command, { initialized: true }, 'Plinthway initialized');
    });
}
