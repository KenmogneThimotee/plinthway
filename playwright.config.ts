import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const systemChromium = '/usr/bin/chromium-browser';
const executablePath = existsSync(systemChromium) ? systemChromium : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'mcp-app-security.spec.ts',
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      ...(executablePath === undefined ? {} : { executablePath, args: ['--no-sandbox'] }),
    },
  },
});
