import { join } from 'node:path';

import { PACKAGE_NAME } from '../state.js';
import { makeCommandAdapter, parseJsonCommandOutput } from './base.js';

const PLUGIN_ID = 'goliath-browser';

function parseEntry(output) {
  const value = parseJsonCommandOutput(output, 'openclaw plugins inspect');
  const plugin = value?.plugin;
  if (!plugin) return null;
  return { id: plugin.id, packageName: plugin.packageName || plugin.name, version: plugin.version };
}

export function openClawAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'openclaw',
    identity: 'openclaw',
    executable: 'openclaw',
    version,
    entry: { id: PLUGIN_ID, packageName: PACKAGE_NAME, version },
    runCommand,
    configPath: join(home, '.openclaw', 'openclaw.json'),
    add: (entry, { replace = false } = {}) => ['openclaw', 'plugins', 'install', '--pin', ...(replace ? ['--force'] : []), `${entry.packageName}@${entry.version}`],
    remove: () => ['openclaw', 'plugins', 'uninstall', '--force', PLUGIN_ID],
    read: () => ['openclaw', 'plugins', 'inspect', PLUGIN_ID, '--json'],
    parse: parseEntry,
    missing: (error) => /plugin not found/i.test(`${error?.stdout || ''} ${error?.stderr || ''} ${error?.message || ''}`),
    canRestore: (entry) => entry?.packageName === PACKAGE_NAME && typeof entry.version === 'string',
  });
}
