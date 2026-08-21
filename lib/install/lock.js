import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory } from './files.js';

const LEGACY_OWNER_FILE = 'owner.json';

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

function readOwner(lockPath) {
  try {
    const stat = lstatSync(lockPath);
    const path = stat.isDirectory() ? join(lockPath, LEGACY_OWNER_FILE) : lockPath;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function acquireHarnessInstallLock(paths, {
  pid = process.pid,
  isAlive = processIsAlive,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  staleMs = 30_000,
  onCandidateReady,
} = {}) {
  const parent = dirname(paths.lock);
  ensurePrivateDirectory(parent);
  const token = randomUUID();
  const owner = { pid, token, startedAt: now() };
  const candidate = join(parent, `.install-lock.${pid}.${token}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(candidate, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (onCandidateReady) onCandidateReady();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // The complete owner file becomes the lock in one atomic filesystem step.
        // A contender can therefore never observe this process's lock half-written.
        linkSync(candidate, paths.lock);
        return {
          release() {
            if (readOwner(paths.lock)?.token === token) rmSync(paths.lock, { force: true });
          },
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const current = readOwner(paths.lock);
        if (current?.pid && isAlive(current.pid)) {
          throw new Error(`another Goliath harness install is running (pid ${current.pid})`);
        }
        let stat;
        try {
          stat = lstatSync(paths.lock);
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        const ageMs = Math.max(0, nowMs() - stat.mtimeMs);
        if (!current && ageMs < staleMs) {
          throw new Error('another Goliath harness install is acquiring the lock');
        }
        // Portable Node.js filesystems do not provide an atomic
        // compare-and-unlink primitive. Removing a lock after separately
        // reading its owner is unsafe: another contender can replace the stale
        // lock in between and we would delete that new live owner's lock.
        // Fail closed and require deliberate operator cleanup instead. This is
        // rarer than corrupting two harness configurations concurrently, and
        // preserves the exact lock for inspection.
        const ownerDetail = current?.pid ? ` owned by non-running pid ${current.pid}` : '';
        throw new Error(
          `stale Goliath harness install lock${ownerDetail} at ${paths.lock}; `
          + 'verify no installer is running, remove that exact lock, and retry',
        );
      }
    }
    throw new Error('could not acquire Goliath harness install lock');
  } finally {
    if (descriptor != null) closeSync(descriptor);
    rmSync(candidate, { force: true });
  }
}
