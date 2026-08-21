import { join } from 'node:path';

import { makeCommandAdapter } from './base.js';

export function claudeCodeAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'claude-code',
    identity: 'claude-code',
    executable: 'claude',
    version,
    runCommand,
    configPath: join(home, '.claude.json'),
    add: (entry) => ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', '--env', 'GOLIATH_USER_ID=claude-code', 'goliath', '--', entry.command, ...entry.args],
    remove: () => ['claude', 'mcp', 'remove', '--scope', 'user', 'goliath'],
    validate: () => ['claude', 'mcp', 'get', 'goliath'],
  });
}
