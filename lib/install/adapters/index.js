import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { hermesAdapter } from './hermes.js';
import { openClawAdapter } from './openclaw.js';
import { generatedMcpEntry } from './base.js';

export const HARNESS_IDS = Object.freeze(['codex', 'claude-code', 'cursor', 'hermes', 'openclaw']);

export function genericMcpConfig(version) {
  return { mcpServers: { goliath: generatedMcpEntry('my-agent', version) } };
}

export function createHarnessAdapters(options) {
  return [
    codexAdapter(options),
    claudeCodeAdapter(options),
    cursorAdapter(options),
    hermesAdapter(options),
    openClawAdapter(options),
  ];
}
