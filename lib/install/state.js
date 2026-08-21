import { existsSync, readFileSync, rmSync } from 'node:fs';

import { atomicWrite } from './files.js';

export const PACKAGE_NAME = '@mechanica-labs/goliath';

function parseJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateHarnessState(state) {
  if (!state || state.schemaVersion !== 1) throw new Error('unsupported harness installer state schema');
  if (state.package?.name !== PACKAGE_NAME || typeof state.package?.version !== 'string') {
    throw new Error('harness installer state has an invalid package identity');
  }
  if (!state.clients || typeof state.clients !== 'object' || Array.isArray(state.clients)) {
    throw new Error('harness installer state clients must be an object');
  }
  if (!Array.isArray(state.backups)) throw new Error('harness installer state backups must be an array');
  return state;
}

export function readHarnessState(paths) {
  if (!existsSync(paths.state)) return null;
  return validateHarnessState(parseJson(paths.state, 'harness installer state'));
}

export function writeHarnessState(paths, state) {
  validateHarnessState(state);
  atomicWrite(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function writeJournal(paths, journal) {
  const value = {
    schemaVersion: 1,
    runId: journal.runId,
    operation: journal.operation,
    backups: [...(journal.backups || [])],
    appliedClients: [...(journal.appliedClients || [])],
    startedAt: journal.startedAt || new Date().toISOString(),
  };
  atomicWrite(paths.journal, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export function readJournal(paths) {
  if (!existsSync(paths.journal)) return null;
  const journal = parseJson(paths.journal, 'harness installer transaction');
  if (journal?.schemaVersion !== 1 || !journal.runId || !Array.isArray(journal.appliedClients)) {
    throw new Error('harness installer transaction has an invalid schema');
  }
  return journal;
}

export function clearJournal(paths) {
  rmSync(paths.journal, { force: true });
}
