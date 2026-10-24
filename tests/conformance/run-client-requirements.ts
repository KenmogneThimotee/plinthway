#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const revision = '2026-07-28';
const requirementsPath = fileURLToPath(
  new URL(
    `../../node_modules/@modelcontextprotocol/conformance/requirements/${revision}.yaml`,
    import.meta.url,
  ),
);
const requirements = await readFile(requirementsPath, 'utf8');
const clientSection = requirements.match(/^client:\n((?: {2}- .+\n)+)/mu)?.[1];
if (clientSection === undefined) throw new Error(`No client requirements found for ${revision}`);

const scenarios = [...clientSection.matchAll(/^ {2}- (.+)$/gmu)].map((match) => match[1]);
if (scenarios.length === 0) throw new Error(`No client scenarios found for ${revision}`);

const requestedConcurrency = Number(process.env.MCP_CONFORMANCE_CONCURRENCY ?? '4');
if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
  throw new Error('MCP_CONFORMANCE_CONCURRENCY must be a positive integer');
}
const concurrency = Math.min(requestedConcurrency, scenarios.length);
const failures: string[] = [];
let nextScenario = 0;

async function runScenario(scenario: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(
      executable,
      [
        'exec',
        'conformance',
        'client',
        '--command',
        'pnpm exec tsx tests/conformance/mcp-client.ts',
        '--scenario',
        scenario,
        '--spec-version',
        revision,
      ],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${scenario} was terminated by ${signal}`));
        return;
      }
      resolve(code === 0);
    });
  });
}

async function worker(): Promise<void> {
  while (nextScenario < scenarios.length) {
    const scenario = scenarios[nextScenario];
    nextScenario += 1;
    if (scenario === undefined) return;
    if (!(await runScenario(scenario))) failures.push(scenario);
  }
}

console.log(
  `Running ${String(scenarios.length)} required MCP client scenarios for ${revision} with concurrency ${String(concurrency)}`,
);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (failures.length > 0) {
  console.error(`Failed required scenarios: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Passed all ${String(scenarios.length)} required MCP client scenarios for ${revision}`,
  );
}
