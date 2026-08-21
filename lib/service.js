// Detached server lifecycle: start, stop, and inspect a background Goliath.
//
// `npm start` runs the server in the foreground, which is what you want in
// Docker or under a supervisor. The bootstrap flow needs the opposite: bring the
// server up, confirm it actually serves traffic, and return the shell. That
// means a PID file, a log file, and a readiness probe.
//
// State lives in <root>/.goliath/ so multiple checkouts on one machine each
// track their own process. That directory is already gitignored.

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

export const DEFAULT_PORT = 9377;
export const READY_TIMEOUT_MS = 90_000;

export function runtimeDir(root) {
  return join(root, '.goliath');
}

export function pidFilePath(root) {
  return join(runtimeDir(root), 'server.json');
}

export function logFilePath(root) {
  return join(runtimeDir(root), 'server.log');
}

/** Port resolution, mirroring the precedence in lib/config.js. */
export function resolvePort(env = process.env) {
  const raw = env.GOLIATH_PORT || env.CAMOFOX_PORT || env.PORT;
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

/** Parsed PID file, or null when absent or corrupt. */
export function readRecord(root) {
  try {
    const record = JSON.parse(readFileSync(pidFilePath(root), 'utf8'));
    return Number.isFinite(record?.pid) ? record : null;
  } catch {
    return null;
  }
}

function writeRecord(root, record) {
  mkdirSync(runtimeDir(root), { recursive: true });
  writeFileSync(pidFilePath(root), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Is `pid` alive and actually a Goliath server?
 *
 * The PID alone is not enough: PIDs are recycled, and a stale file could point
 * at an unrelated process that a stop command would then kill. Where `ps` is
 * available the command line is checked too. `signal 0` performs the liveness
 * check without delivering anything.
 */
export function isServerProcess(pid, { plat = platform(), execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (plat === 'win32' || !execFileSync) return true;
  try {
    // execFileSync, not execSync: no shell is spawned, so the PID can never be
    // interpreted as a command even if the state file were tampered with.
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /server\.js/.test(command);
  } catch {
    return false;
  }
}

/** Current state, clearing the PID file when it refers to a dead process. */
export async function status(root, { env = process.env } = {}) {
  const record = readRecord(root);
  if (!record) return { running: false, port: resolvePort(env) };

  const { execFileSync } = await import('node:child_process');
  if (!isServerProcess(record.pid, { execFileSync })) {
    rmSync(pidFilePath(root), { force: true });
    return { running: false, stale: true, port: record.port ?? resolvePort(env) };
  }

  return {
    running: true,
    pid: record.pid,
    port: record.port ?? resolvePort(env),
    startedAt: record.startedAt ?? null,
    uptimeMs: record.startedAt ? Date.now() - Date.parse(record.startedAt) : null,
  };
}

/**
 * Poll /health until the server reports ready.
 *
 * /health is deliberately exempt from access-key auth (it backs the Docker and
 * Fly healthchecks), so no credentials are needed here.
 */
export async function waitForHealth(port, {
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = 400,
  fetchImpl = fetch,
  now = () => Date.now(),
  onAttempt = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError = 'no response';

  while (now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body?.ok) return body;
        lastError = `health reported not ok: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (err) {
      lastError = err.message;
    }
    onAttempt(lastError);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`server did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastError})`);
}

/** Last `count` lines of the server log, for surfacing a failed startup. */
export function tailLog(root, count = 20) {
  try {
    return readFileSync(logFilePath(root), 'utf8').trimEnd().split('\n').slice(-count);
  } catch {
    return [];
  }
}

/**
 * Start the server detached and wait until it serves traffic.
 *
 * On a readiness failure the process is stopped again rather than left running
 * in a broken state, and the log tail is attached to the thrown error.
 */
export async function start(root, {
  env = process.env,
  port = resolvePort(env),
  timeoutMs = READY_TIMEOUT_MS,
  onAttempt = () => {},
} = {}) {
  const existing = await status(root, { env });
  if (existing.running) return { ...existing, alreadyRunning: true };

  mkdirSync(runtimeDir(root), { recursive: true });
  const logPath = logFilePath(root);
  appendFileSync(logPath, `\n--- goliath start ${new Date().toISOString()} ---\n`);
  const logFd = openSync(logPath, 'a');

  const { spawn: launch } = await import('node:child_process');
  const child = launch(process.execPath, [join(root, 'server.js')], {
    cwd: root,
    env: { ...env, GOLIATH_PORT: String(port) },
    // Detached with the parent's stdio replaced by the log file: the server
    // outlives this command and never writes to the caller's terminal.
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const startedAt = new Date().toISOString();
  writeRecord(root, { pid: child.pid, port, startedAt, node: process.version });

  try {
    const health = await waitForHealth(port, { timeoutMs, onAttempt });
    return { running: true, pid: child.pid, port, startedAt, health };
  } catch (err) {
    await stop(root);
    const error = new Error(err.message);
    error.logTail = tailLog(root);
    throw error;
  }
}

/** Stop the running server, escalating to SIGKILL if it ignores SIGTERM. */
export async function stop(root, { timeoutMs = 10_000, intervalMs = 200 } = {}) {
  const record = readRecord(root);
  if (!record) return { stopped: false, reason: 'not running' };

  const { execFileSync } = await import('node:child_process');
  if (!isServerProcess(record.pid, { execFileSync })) {
    rmSync(pidFilePath(root), { force: true });
    return { stopped: false, reason: 'not running', stale: true };
  }

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    rmSync(pidFilePath(root), { force: true });
    return { stopped: false, reason: 'not running' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isServerProcess(record.pid, { execFileSync })) {
      rmSync(pidFilePath(root), { force: true });
      return { stopped: true, pid: record.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  try {
    process.kill(record.pid, 'SIGKILL');
  } catch { /* already gone */ }
  rmSync(pidFilePath(root), { force: true });
  return { stopped: true, pid: record.pid, forced: true };
}

export function hasRuntimeState(root) {
  return existsSync(pidFilePath(root));
}
