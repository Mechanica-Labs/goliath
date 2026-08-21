import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, expect } from '@jest/globals';

import {
  isBrowserInstalled,
  LINUX_BROWSER_APT_PACKAGE_CANDIDATES,
  LINUX_BROWSER_APT_PACKAGES,
  inspectLinuxRuntimeDependencies,
} from '../../lib/browser-install.js';

const temporaryPaths = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('detects a browser cache only after version metadata exists', () => {
  const cache = mkdtempSync(join(tmpdir(), 'goliath-browser-test-'));
  temporaryPaths.push(cache);
  const config = { camoufoxExecutablePath: '', camoufoxCacheDir: cache };

  expect(isBrowserInstalled(config)).toBe(false);
  writeFileSync(join(cache, 'version.json'), '{"version":"150.0.2"}');
  expect(isBrowserInstalled(config)).toBe(true);
});

test('accepts a configured external executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'goliath-browser-test-'));
  temporaryPaths.push(root);
  const executable = join(root, 'camoufox');
  writeFileSync(executable, 'binary');

  expect(isBrowserInstalled({ camoufoxExecutablePath: executable, camoufoxCacheDir: join(root, 'cache') })).toBe(true);
});

test('Linux browser apt package list includes the GTK runtime dependency', () => {
  expect(LINUX_BROWSER_APT_PACKAGES).toContain('libgtk-3-0');
  expect(LINUX_BROWSER_APT_PACKAGES).toContain('xvfb');
  expect(LINUX_BROWSER_APT_PACKAGE_CANDIDATES).toContainEqual(['libasound2t64', 'libasound2']);
});

test('inspectLinuxRuntimeDependencies reports missing shared libraries from ldd output', async () => {
  const report = await inspectLinuxRuntimeDependencies({
    plat: 'linux',
    executable: process.execPath,
    runFile: () => [
      'linux-vdso.so.1 (0x00007ffd6f5f9000)',
      'libgtk-3.so.0 => not found',
      'libdbus-glib-1.so.2 => not found',
      'libgtk-3.so.0 => not found',
      'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f41d0000000)',
    ].join('\n'),
  });

  expect(report.ok).toBe(false);
  expect(report.missing).toEqual(['libdbus-glib-1.so.2', 'libgtk-3.so.0']);
  expect(report.issues).toContain('missing shared library: libgtk-3.so.0');
});

test('inspectLinuxRuntimeDependencies skips non-Linux platforms', async () => {
  await expect(inspectLinuxRuntimeDependencies({ plat: 'darwin' })).resolves.toEqual({
    ok: true,
    skipped: true,
    reason: 'not_linux',
    missing: [],
    issues: [],
  });
});
