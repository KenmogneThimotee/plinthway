import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PlinthwayError } from '@plinthway/shared';

export interface AtomicWriteOptions {
  readonly platform?: NodeJS.Platform;
}

function isRetryableWindowsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'EPERM' || error.code === 'EACCES';
}

async function replaceFile(
  temporaryPath: string,
  destinationPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const attempts = platform === 'win32' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(temporaryPath, destinationPath);
      return;
    } catch (error) {
      if (attempt === attempts || !isRetryableWindowsError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
}

export async function atomicWriteFile(
  destinationPath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const directory = path.dirname(destinationPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }

    await replaceFile(temporaryPath, destinationPath, platform);
    temporaryExists = false;

    if (platform !== 'win32') {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw new PlinthwayError(
      'STORAGE_ERROR',
      'Could not atomically write file',
      { path: destinationPath },
      { cause: error },
    );
  }
}
