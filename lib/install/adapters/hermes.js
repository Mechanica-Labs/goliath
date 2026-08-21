import { join } from 'node:path';

import { makeCommandAdapter } from './base.js';

export function hermesAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'hermes',
    identity: 'hermes',
    executable: 'hermes',
    version,
    runCommand,
    configPath: join(home, '.hermes', 'config.yaml'),
    add: (entry) => ['hermes', 'mcp', 'add', 'goliath', '--command', entry.command, '--env', 'GOLIATH_USER_ID=hermes', '--args', ...entry.args],
    remove: () => ['hermes', 'mcp', 'remove', 'goliath'],
    validate: () => ['hermes', 'mcp', 'test', 'goliath'],
  });
}
