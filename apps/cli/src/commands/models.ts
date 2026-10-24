import type { Command } from 'commander';

import type { CliContext } from '../application.js';
import { requireService, writeRecord } from '../application.js';

export function registerModelCommands(program: Command, context: CliContext): void {
  const models = program.command('models').description('inspect or update the model catalog');
  models.command('sync').action(async (_options, command: Command) => {
    const result = await requireService(context.application.models, 'Model registry').sync();
    writeRecord(context, command, result, `${String(result.modelCount)} models (${result.source})`);
  });
  models
    .command('list')
    .option('--provider <id>')
    .action((options: { provider?: string }, command: Command) => {
      const values = requireService(context.application.models, 'Model registry').list({
        ...(options.provider === undefined ? {} : { provider: options.provider }),
      });
      writeRecord(context, command, values, values.map((model) => model.id).join('\n'));
    });
}
