import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, describe, afterEach } from '@jest/globals';

import {
  cacheDir,
  downloadTo,
  executablePath,
  externalExecutableFromEnv,
  readInstalledVersion,
  shouldSkipDownload,
  versionFilePath,
} from './browser-install.js';

const staging = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'goliath-install-test-'));
  staging.push(dir);
  return dir;
}

afterEach(() => {
  while (staging.length) rmSync(staging.pop(), { recursive: true, force: true });
});

/** Minimal stand-in for a fetch Response backed by a web ReadableStream. */
function fakeResponse(chunks, { total, ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Server Error',
    headers: {
      get: (name) => (name === 'content-length' && total != null ? String(total) : null),
    },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    }),
  };
}

describe('cache locations', () => {
  test('resolve per platform', () => {
    expect(cacheDir({}, 'darwin')).toMatch(/Library\/Caches\/camoufox$/);
    expect(cacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe('/xdg/camoufox');
    // camoufox-js nests the app name twice on Windows; the installer must match.
    expect(cacheDir({ LOCALAPPDATA: 'C:\\local' }, 'win32')).toContain('camoufox');
  });

  test('version marker lives inside the cache directory', () => {
    expect(versionFilePath({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe('/xdg/camoufox/version.json');
  });

  test('executable path matches each platform bundle layout', () => {
    expect(executablePath({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe('/xdg/camoufox/camoufox-bin');
    expect(executablePath({}, 'darwin')).toMatch(/Camoufox\.app\/Contents\/MacOS\/camoufox$/);
    expect(executablePath({ LOCALAPPDATA: 'C:\\local' }, 'win32')).toMatch(/camoufox\.exe$/);
  });
});

describe('environment overrides', () => {
  test('the Goliath name wins over the legacy Camoufox aliases', () => {
    const found = externalExecutableFromEnv({
      CAMOUFOX_EXECUTABLE: '/legacy',
      GOLIATH_EXECUTABLE: '/preferred',
    });
    expect(found).toEqual({ name: 'GOLIATH_EXECUTABLE', value: '/preferred' });
  });

  test('legacy aliases are still honored', () => {
    expect(externalExecutableFromEnv({ CAMOFOX_EXECUTABLE_PATH: '/x' }).value).toBe('/x');
  });

  test('blank values are ignored', () => {
    expect(externalExecutableFromEnv({ GOLIATH_EXECUTABLE: '   ' })).toBeNull();
    expect(externalExecutableFromEnv({})).toBeNull();
  });

  test('both skip-download spellings are accepted', () => {
    expect(shouldSkipDownload({ GOLIATH_SKIP_DOWNLOAD: '1' })).toBe(true);
    expect(shouldSkipDownload({ CAMOFOX_SKIP_DOWNLOAD: 'true' })).toBe(true);
    expect(shouldSkipDownload({ GOLIATH_SKIP_DOWNLOAD: '0' })).toBe(false);
    expect(shouldSkipDownload({})).toBe(false);
  });
});

describe('readInstalledVersion', () => {
  test('returns null when the marker is absent', () => {
    expect(readInstalledVersion({ XDG_CACHE_HOME: tempDir() }, 'linux')).toBeNull();
  });

  test('returns null for corrupt JSON instead of throwing', () => {
    const cache = tempDir();
    const dir = join(cache, 'camoufox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'version.json'), '{not json');
    expect(readInstalledVersion({ XDG_CACHE_HOME: cache }, 'linux')).toBeNull();
  });
});

describe('downloadTo', () => {
  test('streams the body to disk and reports progress', async () => {
    const dest = join(tempDir(), 'out.bin');
    const events = [];
    const result = await downloadTo('https://example.test/a.zip', dest, {
      onProgress: (event) => events.push(event),
      fetchImpl: async () => fakeResponse([[1, 2, 3], [4, 5]], { total: 5 }),
    });

    expect(result.bytes).toBe(5);
    expect(statSync(dest).size).toBe(5);
    expect(readFileSync(dest)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(events[0]).toMatchObject({ phase: 'start', total: 5 });
    expect(events.at(-1)).toMatchObject({ phase: 'data', transferred: 5 });
  });

  test('a missing content-length yields a null total rather than NaN', async () => {
    const dest = join(tempDir(), 'out.bin');
    const events = [];
    await downloadTo('https://example.test/a.zip', dest, {
      onProgress: (event) => events.push(event),
      fetchImpl: async () => fakeResponse([[1, 2]], { total: null }),
    });
    expect(events[0].total).toBeNull();
  });

  test('rejects a truncated body instead of leaving a corrupt archive', async () => {
    const dest = join(tempDir(), 'out.bin');
    await expect(downloadTo('https://example.test/a.zip', dest, {
      retries: 1,
      fetchImpl: async () => fakeResponse([[1, 2]], { total: 99 }),
    })).rejects.toThrow(/truncated download/);
  });

  test('retries a failing attempt and succeeds', async () => {
    const dest = join(tempDir(), 'out.bin');
    let attempts = 0;
    const events = [];
    const result = await downloadTo('https://example.test/a.zip', dest, {
      onProgress: (event) => events.push(event),
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return fakeResponse([], { ok: false, status: 500 });
        return fakeResponse([[7, 7, 7]], { total: 3 });
      },
    });

    expect(attempts).toBe(2);
    expect(result.bytes).toBe(3);
    expect(events.some((event) => event.phase === 'retry')).toBe(true);
  });

  test('gives up after the retry budget and reports the last error', async () => {
    const dest = join(tempDir(), 'out.bin');
    await expect(downloadTo('https://example.test/a.zip', dest, {
      retries: 2,
      fetchImpl: async () => fakeResponse([], { ok: false, status: 404 }),
    })).rejects.toThrow(/failed to download after 2 attempts/);
  });
});
