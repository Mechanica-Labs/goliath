import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('plugin manager command boundaries', () => {
  test('passes Git URLs as literal arguments without shell expansion', () => {
    if (process.platform === 'win32') return;

    const temp = mkdtempSync(join(tmpdir(), 'goliath-plugin-security-'));
    const fakeBin = join(temp, 'bin');
    const marker = join(temp, 'shell-expanded');
    const fakeGit = join(fakeBin, 'git');

    try {
      mkdirSync(fakeBin);
      writeFileSync(fakeGit, '#!/bin/sh\nexit 1\n', { flag: 'wx' });
      chmodSync(fakeGit, 0o755);

      const maliciousUrl = `https://example.invalid/$(touch ${marker})/plugin`;
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'plugin.js'), 'install', maliciousUrl],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ''}` },
        }
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
