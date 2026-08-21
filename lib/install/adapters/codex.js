import { join } from 'node:path';

import { generatedMcpEntry, makeCommandAdapter, parseJsonCommandOutput } from './base.js';

function parseEntry(output) {
  const value = parseJsonCommandOutput(output, 'codex mcp get');
  if (!value?.transport || value.transport.type !== 'stdio') return null;
  return {
    command: value.transport.command,
    args: value.transport.args || [],
    env: value.transport.env || {},
    cwd: value.transport.cwd ?? null,
    enabledTools: value.enabled_tools ?? null,
    disabledTools: value.disabled_tools ?? null,
    startupTimeoutSec: value.startup_timeout_sec ?? null,
    toolTimeoutSec: value.tool_timeout_sec ?? null,
  };
}

function commandEntry(entry) {
  return {
    command: entry.command,
    args: entry.args || [],
    env: entry.env || {},
    cwd: entry.cwd ?? null,
    enabledTools: entry.enabledTools ?? null,
    disabledTools: entry.disabledTools ?? null,
    startupTimeoutSec: entry.startupTimeoutSec ?? null,
    toolTimeoutSec: entry.toolTimeoutSec ?? null,
  };
}

function canRestore(entry) {
  return entry && entry.cwd == null && entry.enabledTools == null && entry.disabledTools == null
    && entry.startupTimeoutSec == null && entry.toolTimeoutSec == null;
}

export function codexAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'codex',
    identity: 'codex',
    executable: 'codex',
    version,
    entry: commandEntry(generatedMcpEntry('codex', version)),
    runCommand,
    configPath: join(home, '.codex', 'config.toml'),
    add: (entry) => ['codex', 'mcp', 'add', ...Object.entries(entry.env || {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), 'goliath', '--', entry.command, ...(entry.args || [])],
    remove: () => ['codex', 'mcp', 'remove', 'goliath'],
    read: () => ['codex', 'mcp', 'get', 'goliath', '--json'],
    parse: parseEntry,
    missing: (error) => /not found|no MCP server/i.test(`${error?.stdout || ''} ${error?.stderr || ''} ${error?.message || ''}`),
    canRestore,
  });
}
