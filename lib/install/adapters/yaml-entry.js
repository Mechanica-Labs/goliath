import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

import { atomicWrite } from '../files.js';
import { entriesEqual } from './base.js';

function cloneEntry(entry) {
  return entry == null ? null : structuredClone(entry);
}

export function yamlEntryAdapter({ id, identity, executable, configPath, entry, path }) {
  function readDocument() {
    const document = parseDocument(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
    if (document.errors.length) throw new Error(`${id} configuration is malformed: ${document.errors[0].message}`);
    return document;
  }

  function currentFrom(document) {
    const node = document.getIn(path, true);
    return node == null ? null : cloneEntry(node.toJSON());
  }

  const adapter = {
    id,
    identity,
    executable,
    configPath,
    generatedEntry: () => cloneEntry(entry),
    currentEntry: async () => currentFrom(readDocument()),
    existingEntry: async () => currentFrom(readDocument()),
    supportsReplacement: () => true,
    async apply(value = entry, options = {}) {
      const document = readDocument();
      if (Object.hasOwn(options, 'expected') && !entriesEqual(currentFrom(document), options.expected)) {
        throw new Error(`${id} Goliath entry has drifted; refusing to modify it`);
      }
      document.setIn(path, cloneEntry(value));
      atomicWrite(configPath, String(document));
    },
    async validate(expected = entry) {
      if (!entriesEqual(await adapter.currentEntry(), expected)) {
        throw new Error(`${id} Goliath entry has drifted; refusing to modify it`);
      }
    },
    async reconcile(expected, replacement = null) {
      const document = readDocument();
      if (!entriesEqual(currentFrom(document), expected)) {
        throw new Error(`${id} Goliath entry has drifted; refusing to modify it`);
      }
      if (replacement == null) document.deleteIn(path);
      else document.setIn(path, cloneEntry(replacement));
      const parent = path.slice(0, -1);
      const parentNode = document.getIn(parent, true);
      if (parentNode?.items?.length === 0) document.deleteIn(parent);
      atomicWrite(configPath, String(document));
      if (!entriesEqual(await adapter.currentEntry(), replacement)) {
        throw new Error(`${id} Goliath entry reconciliation did not persist`);
      }
    },
    async remove(expected = entry) {
      return adapter.reconcile(expected, null);
    },
  };
  return adapter;
}
