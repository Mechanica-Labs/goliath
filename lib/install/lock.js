import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function acquireHarnessInstallLock(paths, {
  pid = process.pid,
  isAlive = processIsAlive,
  now = () => new Date().toISOString(),
} = {}) {
  mkdirSync(dirname(paths.lock), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const owner = { pid, token, startedAt: now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(paths.lock, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
      closeSync(descriptor);
      descriptor = undefined;
      return {
        release() {
          if (readOwner(paths.lock)?.token === token) rmSync(paths.lock, { force: true });
        },
      };
    } catch (error) {
      if (descriptor != null) closeSync(descriptor);
      if (error?.code !== 'EEXIST') throw error;
      const current = readOwner(paths.lock);
      if (current?.pid && isAlive(current.pid)) {
        throw new Error(`another Goliath harness install is running (pid ${current.pid})`);
      }
      rmSync(paths.lock, { force: true });
    }
  }
  throw new Error('could not acquire Goliath harness install lock');
}
