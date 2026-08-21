import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, expect } from '@jest/globals';

import { isBrowserInstalled } from '../../lib/browser-install.js';

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
