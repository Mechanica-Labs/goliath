import { join } from 'node:path';

import { makeCommandAdapter } from './base.js';

export function codexAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'codex',
    identity: 'codex',
    executable: 'codex',
    version,
    runCommand,
    configPath: join(home, '.codex', 'config.toml'),
    add: (entry) => ['codex', 'mcp', 'add', '--env', 'GOLIATH_USER_ID=codex', 'goliath', '--', entry.command, ...entry.args],
    remove: () => ['codex', 'mcp', 'remove', 'goliath'],
    validate: () => ['codex', 'mcp', 'get', 'goliath', '--json'],
  });
}
