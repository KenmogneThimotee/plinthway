import { spawn, type ChildProcess } from 'node:child_process';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ignoreMissingProcess(error: unknown): void {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ESRCH' || error.code === 'ENOENT')
  ) {
    return;
  }
  throw error;
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
    });
    killer.once('error', () => {
      resolve();
    });
    killer.once('close', () => {
      resolve();
    });
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await taskkill(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    ignoreMissingProcess(error);
  }
  await delay(100);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    ignoreMissingProcess(error);
  }
}
