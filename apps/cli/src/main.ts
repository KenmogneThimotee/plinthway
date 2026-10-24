#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PlinthwayError } from '@plinthway/shared';

import { exitCodeFor, runCli } from './application.js';
import { createApplication } from './bootstrap.js';

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  const onInterrupt = (): void => {
    interrupts += 1;
    controller.abort(new PlinthwayError('CANCELLED', 'Interrupted by SIGINT'));
    if (interrupts > 1) process.exitCode = 5;
  };
  process.on('SIGINT', onInterrupt);
  let close: (() => Promise<void>) | undefined;
  try {
    const bootstrapped = await createApplication({
      env: process.env,
      cwd: process.cwd(),
      stdin: process.stdin,
      stderr: process.stderr,
    });
    close = bootstrapped.close;
    return await runCli(arguments_, {
      application: bootstrapped.application,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      initializeHome: bootstrapped.initializeHome,
      signal: controller.signal,
    });
  } catch (error) {
    const safe =
      error instanceof PlinthwayError
        ? error.toJSON()
        : { code: 'INTERNAL_ERROR', message: 'Plinthway failed to start' };
    process.stderr.write(`${String(safe.code)}: ${String(safe.message)}\n`);
    return exitCodeFor(error);
  } finally {
    process.off('SIGINT', onInterrupt);
    await close?.();
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
