import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { atomicWriteFile } from './atomic-file.js';

describe('atomicWriteFile', () => {
  it('atomically replaces an existing file with private permissions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-atomic-'));
    const file = path.join(directory, 'config.yaml');

    await atomicWriteFile(file, 'first');
    await atomicWriteFile(file, 'second');

    await expect(readFile(file, 'utf8')).resolves.toBe('second');
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });
});
