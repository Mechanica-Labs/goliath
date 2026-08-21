import { existsSync, readFileSync } from 'node:fs';

import { atomicWrite } from '../files.js';
import { entriesEqual } from './base.js';

function cloneEntry(entry) {
  return entry == null ? null : structuredClone(entry);
}

export function jsonEntryAdapter({
  id,
  identity,
  executable,
  configPath,
  entry,
  mapKey,
  entryKey,
  detected,
  applyWithClient,
}) {
  function read() {
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`${id} configuration is malformed: ${error.message}`);
    }
  }

  function writeEntry(expected, replacement) {
    const config = read();
    const current = config[mapKey]?.[entryKey] ?? null;
    if (expected !== undefined && !entriesEqual(current, expected)) {
      throw new Error(`${id} Goliath entry has drifted; refusing to modify it`);
    }
    if (replacement == null) {
      if (config[mapKey]) {
        delete config[mapKey][entryKey];
        if (Object.keys(config[mapKey]).length === 0) delete config[mapKey];
      }
    } else {
      config[mapKey] = { ...(config[mapKey] || {}), [entryKey]: cloneEntry(replacement) };
    }
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const adapter = {
    id,
    identity,
    executable,
    configPath,
    generatedEntry: () => cloneEntry(entry),
    currentEntry: async () => cloneEntry(read()[mapKey]?.[entryKey] ?? null),
    existingEntry: async () => cloneEntry(read()[mapKey]?.[entryKey] ?? null),
    supportsReplacement: () => true,
    async apply(value = entry, options = {}) {
      if (applyWithClient && !options.replace) await applyWithClient(value, options);
      else writeEntry(Object.hasOwn(options, 'expected') ? options.expected : undefined, value);
    },
    async validate(expected = entry) {
      if (!entriesEqual(await adapter.currentEntry(), expected)) {
        throw new Error(`${id} Goliath entry has drifted; refusing to modify it`);
      }
    },
    async reconcile(expected, replacement = null) {
      writeEntry(expected, replacement);
      if (!entriesEqual(await adapter.currentEntry(), replacement)) {
        throw new Error(`${id} Goliath entry reconciliation did not persist`);
      }
    },
    async remove(expected = entry) {
      return adapter.reconcile(expected, null);
    },
  };
  if (detected) adapter.detected = detected;
  return adapter;
}
