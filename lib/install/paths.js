import { join } from 'node:path';

export function harnessInstallPaths(homeDirectory) {
  if (!homeDirectory) throw new Error('home directory is required');
  const root = join(homeDirectory, '.goliath', 'harness-install');
  return Object.freeze({
    root,
    state: join(root, 'state.json'),
    journal: join(root, 'transaction.json'),
    lock: join(root, 'install.lock'),
    backups: join(root, 'backups'),
  });
}
