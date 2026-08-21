import { join } from 'node:path';

import { yamlEntryAdapter } from './yaml-entry.js';
import { generatedMcpEntry } from './base.js';

export function hermesAdapter({ home, version }) {
  return yamlEntryAdapter({
    id: 'hermes',
    identity: 'hermes',
    executable: 'hermes',
    configPath: join(home, '.hermes', 'config.yaml'),
    entry: generatedMcpEntry('hermes', version),
    path: ['mcp_servers', 'goliath'],
  });
}
