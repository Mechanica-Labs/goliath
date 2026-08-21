import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWrite } from '../files.js';
import { entriesEqual, generatedMcpEntry } from './base.js';

export function cursorAdapter({ home, version }) {
  const configPath = join(home, '.cursor', 'mcp.json');
  const generated = generatedMcpEntry('cursor', version);

  function read() {
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cursor MCP configuration is malformed: ${error.message}`);
    }
  }

  return {
    id: 'cursor',
    identity: 'cursor',
    configPath,
    generatedEntry: () => structuredClone(generated),
    existingEntry: () => read().mcpServers?.goliath || null,
    detected: () => existsSync(join(home, '.cursor')) || existsSync('/Applications/Cursor.app'),
    async apply() {
      const config = read();
      config.mcpServers = { ...(config.mcpServers || {}), goliath: generated };
      atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    },
    async validate() {
      if (!entriesEqual(read().mcpServers?.goliath, generated)) {
        throw new Error('Cursor Goliath MCP entry does not match the managed configuration');
      }
    },
    async remove() {
      const config = read();
      if (!entriesEqual(config.mcpServers?.goliath, generated)) {
        throw new Error('Cursor Goliath MCP entry has drifted; refusing to remove it');
      }
      delete config.mcpServers.goliath;
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
      atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    },
  };
}
