import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, describe, afterEach } from '@jest/globals';

import {
  DEFAULT_PORT,
  isServerProcess,
  logFilePath,
  pidFilePath,
  readRecord,
  resolvePort,
  runtimeDir,
  status,
  stop,
  tailLog,
  waitForHealth,
} from './service.js';

const staging = [];

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'goliath-service-test-'));
  staging.push(dir);
  return dir;
}

function writeState(root, record) {
  mkdirSync(runtimeDir(root), { recursive: true });
  writeFileSync(pidFilePath(root), JSON.stringify(record));
}

afterEach(() => {
  while (staging.length) rmSync(staging.pop(), { recursive: true, force: true });
});

function healthResponse(body, { ok = true, status: code = 200 } = {}) {
  return { ok, status: code, json: async () => body };
}

describe('paths and port resolution', () => {
  test('state lives under the gitignored .goliath directory', () => {
    expect(runtimeDir('/srv/app')).toBe('/srv/app/.goliath');
    expect(pidFilePath('/srv/app')).toBe('/srv/app/.goliath/server.json');
    expect(logFilePath('/srv/app')).toBe('/srv/app/.goliath/server.log');
  });

  test('port precedence matches lib/config.js', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: '3000' })).toBe(3000);
    expect(resolvePort({ PORT: '3000', CAMOFOX_PORT: '4000' })).toBe(4000);
    expect(resolvePort({ CAMOFOX_PORT: '4000', GOLIATH_PORT: '5000' })).toBe(5000);
  });

  test('a non-numeric port falls back to the default', () => {
    expect(resolvePort({ GOLIATH_PORT: 'not-a-port' })).toBe(DEFAULT_PORT);
  });
});

describe('readRecord', () => {
  test('returns null when there is no state file', () => {
    expect(readRecord(tempRoot())).toBeNull();
  });

  test('returns null for corrupt JSON rather than throwing', () => {
    const root = tempRoot();
    mkdirSync(runtimeDir(root), { recursive: true });
    writeFileSync(pidFilePath(root), '{ broken');
    expect(readRecord(root)).toBeNull();
  });

  test('rejects a record with no usable pid', () => {
    const root = tempRoot();
    writeState(root, { port: 9377 });
    expect(readRecord(root)).toBeNull();
  });

  test('returns the parsed record', () => {
    const root = tempRoot();
    writeState(root, { pid: 42, port: 9377 });
    expect(readRecord(root)).toMatchObject({ pid: 42, port: 9377 });
  });
});

describe('isServerProcess', () => {
  test('rejects malformed pids without signalling anything', () => {
    expect(isServerProcess(0)).toBe(false);
    expect(isServerProcess(-1)).toBe(false);
    expect(isServerProcess(1.5)).toBe(false);
    expect(isServerProcess(undefined)).toBe(false);
  });

  test('a live pid whose command is not the server is rejected', () => {
    // This test process is alive but is jest, not server.js -- exactly the
    // PID-reuse case the command check exists to catch.
    expect(isServerProcess(process.pid, {
      execFileSync: () => '/usr/bin/node /somewhere/jest.js',
    })).toBe(false);
  });

  test('a live pid running server.js is accepted', () => {
    expect(isServerProcess(process.pid, {
      execFileSync: () => '/usr/bin/node /srv/goliath/server.js',
    })).toBe(true);
  });

  test('Windows skips the command check because ps is unavailable', () => {
    expect(isServerProcess(process.pid, { plat: 'win32' })).toBe(true);
  });

  test('a dead pid is rejected', () => {
    // PID 2^22 is above the default pid_max on Linux and macOS.
    expect(isServerProcess(4194303, { execFileSync: () => '' })).toBe(false);
  });
});

describe('status', () => {
  test('reports not running when no state file exists', async () => {
    await expect(status(tempRoot())).resolves.toMatchObject({ running: false });
  });

  test('clears a stale state file that points at a dead process', async () => {
    const root = tempRoot();
    writeState(root, { pid: 4194303, port: 9377 });
    const state = await status(root);
    expect(state).toMatchObject({ running: false, stale: true, port: 9377 });
    expect(existsSync(pidFilePath(root))).toBe(false);
  });
});

describe('stop', () => {
  test('is a no-op when nothing is running', async () => {
    await expect(stop(tempRoot())).resolves.toMatchObject({ stopped: false, reason: 'not running' });
  });

  test('clears a stale state file without signalling an unrelated process', async () => {
    const root = tempRoot();
    writeState(root, { pid: 4194303 });
    const result = await stop(root);
    expect(result).toMatchObject({ stopped: false, stale: true });
    expect(existsSync(pidFilePath(root))).toBe(false);
  });
});

describe('waitForHealth', () => {
  const fast = { intervalMs: 1, timeoutMs: 200 };

  test('resolves once /health reports ok', async () => {
    const body = await waitForHealth(9377, {
      ...fast,
      fetchImpl: async () => healthResponse({ ok: true, engine: 'goliath' }),
    });
    expect(body.engine).toBe('goliath');
  });

  test('keeps polling until the server comes up', async () => {
    let calls = 0;
    const body = await waitForHealth(9377, {
      ...fast,
      fetchImpl: async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return healthResponse({ ok: true });
      },
    });
    expect(calls).toBe(3);
    expect(body.ok).toBe(true);
  });

  test('does not accept a body that reports ok:false', async () => {
    await expect(waitForHealth(9377, {
      ...fast,
      fetchImpl: async () => healthResponse({ ok: false }),
    })).rejects.toThrow(/did not become healthy/);
  });

  test('surfaces the last error on timeout', async () => {
    await expect(waitForHealth(9377, {
      ...fast,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    })).rejects.toThrow(/ECONNREFUSED/);
  });

  test('a non-2xx response is not treated as ready', async () => {
    await expect(waitForHealth(9377, {
      ...fast,
      fetchImpl: async () => healthResponse({}, { ok: false, status: 503 }),
    })).rejects.toThrow(/HTTP 503/);
  });
});

describe('tailLog', () => {
  test('returns an empty list when there is no log yet', () => {
    expect(tailLog(tempRoot())).toEqual([]);
  });

  test('returns the trailing lines', () => {
    const root = tempRoot();
    mkdirSync(runtimeDir(root), { recursive: true });
    writeFileSync(logFilePath(root), 'a\nb\nc\nd\n');
    expect(tailLog(root, 2)).toEqual(['c', 'd']);
  });
});
