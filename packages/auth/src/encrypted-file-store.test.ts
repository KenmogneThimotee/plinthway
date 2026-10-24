import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EncryptedFileCredentialStore } from './encrypted-file-store.js';

describe('EncryptedFileCredentialStore', () => {
  it('round-trips credentials with private file permissions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-auth-'));
    const file = path.join(directory, 'credentials.enc');
    const store = new EncryptedFileCredentialStore(file, () => Promise.resolve('correct horse'));

    await store.set('anthropic-api-key:default', { type: 'api-key', secret: 'file-secret' });
    await expect(store.get('anthropic-api-key:default')).resolves.toEqual({
      type: 'api-key',
      secret: 'file-secret',
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects a wrong passphrase and tampered ciphertext safely', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-auth-'));
    const file = path.join(directory, 'credentials.enc');
    const store = new EncryptedFileCredentialStore(file, () => Promise.resolve('correct horse'));
    await store.set('google-api-key:default', { type: 'api-key', secret: 'file-secret' });

    const wrong = new EncryptedFileCredentialStore(file, () => Promise.resolve('wrong horse'));
    await expect(wrong.get('google-api-key:default')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });

    const envelope = JSON.parse(await readFile(file, 'utf8')) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.get('google-api-key:default')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
