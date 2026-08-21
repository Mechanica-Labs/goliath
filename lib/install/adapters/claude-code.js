import { join } from 'node:path';

import { jsonEntryAdapter } from './json-entry.js';
import { generatedMcpEntry } from './base.js';

export function claudeCodeAdapter({ home, version, runCommand }) {
  const entry = { type: 'stdio', ...generatedMcpEntry('claude-code', version) };
  const configPath = join(home, '.claude.json');
  return jsonEntryAdapter({
    id: 'claude-code',
    identity: 'claude-code',
    executable: 'claude',
    configPath,
    entry,
    mapKey: 'mcpServers',
    entryKey: 'goliath',
    async applyWithClient(value) {
      const environment = Object.entries(value.env || {}).flatMap(([key, envValue]) => ['-e', `${key}=${envValue}`]);
      await runCommand(['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'goliath', ...environment, '--', value.command, ...(value.args || [])]);
    },
  });
}
