import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { generatedMcpEntry } from './base.js';
import { jsonEntryAdapter } from './json-entry.js';

export function cursorAdapter({ home, version }) {
  const configPath = join(home, '.cursor', 'mcp.json');
  const generated = generatedMcpEntry('cursor', version);
  return jsonEntryAdapter({
    id: 'cursor',
    identity: 'cursor',
    configPath,
    entry: generated,
    mapKey: 'mcpServers',
    entryKey: 'goliath',
    detected: () => existsSync(join(home, '.cursor')) || existsSync('/Applications/Cursor.app'),
  });
}
