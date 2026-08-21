import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureBrowserInstalled } from '../browser-install.js';
import { loadConfig } from '../config.js';
import { createHarnessAdapters, genericMcpConfig } from './adapters/index.js';
import { entriesEqual } from './adapters/base.js';
import { acquireHarnessInstallLock } from './lock.js';
import { harnessInstallPaths } from './paths.js';
import { runHarnessSmoke } from './smoke.js';
import {
  PACKAGE_NAME,
  clearJournal,
  readHarnessState,
  readJournal,
  removeHarnessState,
  writeHarnessState,
  writeJournal,
} from './state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function runCommand(argv) {
  const [command, ...args] = argv;
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function executableExists(command, pathValue) {
  for (const directory of String(pathValue || '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

function preflight({ platform = process.platform, nodeVersion = process.version } = {}) {
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major < 22) throw new Error('Node.js 22 or newer is required');
  if (!['darwin', 'linux'].includes(platform)) {
    throw new Error('Native Windows is unsupported; install Goliath inside WSL');
  }
}

function initialState(version) {
  return {
    schemaVersion: 1,
    package: { name: PACKAGE_NAME, version },
    clients: {},
    lastSmokeTest: null,
  };
}

function installFailure(stage, error, extra = {}) {
  return {
    schemaVersion: 1,
    status: 'failed',
    exitCode: 1,
    stage,
    errors: [error instanceof Error ? error.message : String(error)],
    ...extra,
  };
}

function defaultDetected(adapter, pathValue) {
  if (adapter.detected) return adapter.detected();
  return Boolean(adapter.executable && executableExists(adapter.executable, pathValue));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isTestInterruption(error) {
  return error?.code === 'GOLIATH_TEST_INTERRUPT';
}

async function transactionBoundary(dependencies, stage, context = {}) {
  if (dependencies.onTransactionBoundary) await dependencies.onTransactionBoundary(stage, context);
}

async function readAdapterEntry(adapter) {
  if (typeof adapter.currentEntry !== 'function') {
    throw new Error(`${adapter.id} adapter cannot structurally inspect its Goliath entry`);
  }
  return clone(await adapter.currentEntry());
}

async function reconcileRecord(adapter, record, target = 'beforeEntry') {
  const source = target === 'beforeEntry' ? 'afterEntry' : 'beforeEntry';
  const current = await readAdapterEntry(adapter);
  if (entriesEqual(current, record[target])) return 'unchanged';
  const resumableMissingIntermediate = current == null
    && adapter.supportsMissingIntermediate === true
    && record[source] != null;
  if (!entriesEqual(current, record[source]) && !resumableMissingIntermediate) {
    throw new Error(`${adapter.id} entry changed during transaction recovery; refusing to overwrite it`);
  }
  if (typeof adapter.reconcile !== 'function') {
    throw new Error(`${adapter.id} adapter cannot reconcile an interrupted transaction`);
  }
  await adapter.reconcile(resumableMissingIntermediate ? null : record[source], record[target]);
  if (!entriesEqual(await readAdapterEntry(adapter), record[target])) {
    throw new Error(`${adapter.id} transaction reconciliation could not be verified`);
  }
  return 'reconciled';
}

async function recoverJournalLocked(paths, journal, adaptersById) {
  const currentState = readHarnessState(paths);
  if (journal.targetState != null && entriesEqual(currentState, journal.targetState)) {
    for (const record of journal.records) {
      const adapter = adaptersById.get(record.client);
      if (!adapter) throw new Error(`adapter unavailable for recovery: ${record.client}`);
      if (!entriesEqual(await readAdapterEntry(adapter), record.afterEntry)) {
        throw new Error(`${record.client} entry drifted after state commit; recovery requires manual reconciliation`);
      }
    }
    clearJournal(paths);
    return { status: 'finalized', runId: journal.runId };
  }

  for (const record of [...journal.records].reverse()) {
    const adapter = adaptersById.get(record.client);
    if (!adapter) throw new Error(`adapter unavailable for recovery: ${record.client}`);
    await reconcileRecord(adapter, record, 'beforeEntry');
  }
  if (journal.priorState == null) removeHarnessState(paths);
  else writeHarnessState(paths, journal.priorState);
  clearJournal(paths);
  return { status: 'rolled_back', runId: journal.runId };
}

async function buildPlan({ adapterList, priorState, options, dependencies, pathValue }) {
  const requested = new Set(options.clients || []);
  const planned = [];
  const clients = [];
  if (options.noConfig) return { planned, clients };

  for (const adapter of adapterList) {
    if (requested.size && !requested.has(adapter.id)) continue;
    const detected = dependencies.detected ? await dependencies.detected(adapter) : defaultDetected(adapter, pathValue);
    if (!detected) {
      if (requested.has(adapter.id)) clients.push({ id: adapter.id, status: 'unsupported', error: `${adapter.id} was explicitly requested but was not detected` });
      continue;
    }

    let current;
    try {
      current = await readAdapterEntry(adapter);
    } catch (error) {
      clients.push({ id: adapter.id, status: 'conflict', error: error.message });
      continue;
    }
    const managed = priorState?.clients?.[adapter.id];
    if (managed) {
      if (!Object.hasOwn(managed, 'managedEntry') || !entriesEqual(current, managed.managedEntry)) {
        planned.push({ adapter, action: 'drift', current, managed });
      } else {
        planned.push({ adapter, action: managed.version === (dependencies.version || PACKAGE.version) ? 'noop_managed' : 'update_managed', current, managed });
      }
      continue;
    }

    if (current == null) {
      planned.push({ adapter, action: 'create', current: null, managed: null });
      continue;
    }
    const replaceable = options.replaceExisting && adapter.supportsReplacement?.(current) !== false;
    planned.push({ adapter, action: replaceable ? 'replace_unmanaged' : 'conflict', current, managed: null });
  }
  return { planned, clients };
}

export async function installHarnesses({ options = {}, dependencies = {} } = {}) {
  const home = dependencies.home || homedir();
  const version = dependencies.version || PACKAGE.version;
  const paths = harnessInstallPaths(home);
  const config = dependencies.config || loadConfig();
  try {
    preflight(dependencies);
  } catch (error) {
    return installFailure('preflight', error);
  }

  const adapterList = dependencies.adapters || createHarnessAdapters({
    home,
    version,
    runCommand: dependencies.runCommand || runCommand,
  });

  if (options.dryRun) {
    let priorState;
    try {
      const journal = readJournal(paths);
      if (journal) return installFailure('recovery_required', new Error(`incomplete ${journal.operation} transaction ${journal.runId}`));
      priorState = readHarnessState(paths);
    } catch (error) {
      return installFailure('managed_state', error);
    }
    const { planned, clients } = await buildPlan({
      adapterList, priorState, options, dependencies: { ...dependencies, version }, pathValue: config.serverEnv?.PATH,
    });
    const hasProblems = clients.length > 0 || planned.some(({ action }) => ['conflict', 'drift'].includes(action));
    return {
      schemaVersion: 1,
      status: 'planned',
      exitCode: hasProblems ? 2 : 0,
      package: { name: PACKAGE_NAME, version },
      smoke: { status: 'not_run', reason: 'dry_run' },
      clients: [...clients, ...planned.map(({ adapter, action }) => ({ id: adapter.id, status: action }))],
      genericMcp: options.noConfig || planned.length === 0 ? genericMcpConfig(version) : undefined,
    };
  }

  let lock;
  try {
    lock = acquireHarnessInstallLock(paths, dependencies.lockOptions);
  } catch (error) {
    return installFailure('lock', error);
  }

  try {
    const adaptersById = new Map(adapterList.map((adapter) => [adapter.id, adapter]));
    let recovery = null;
    try {
      const journal = readJournal(paths);
      if (journal) recovery = await recoverJournalLocked(paths, journal, adaptersById);
    } catch (error) {
      return installFailure('recovery_required', error);
    }

    let priorState;
    try {
      priorState = readHarnessState(paths);
    } catch (error) {
      return installFailure('managed_state', error, { recovery });
    }
    const { planned, clients } = await buildPlan({
      adapterList, priorState, options, dependencies: { ...dependencies, version }, pathValue: config.serverEnv?.PATH,
    });

    try {
      const ensureRuntime = dependencies.ensureRuntime || (() => ensureBrowserInstalled(config, dependencies.io));
      await ensureRuntime();
    } catch (error) {
      return installFailure('runtime', error, { clients, recovery });
    }

    let smoke;
    try {
      smoke = dependencies.smoke
        ? await dependencies.smoke()
        : await runHarnessSmoke({ environment: config.serverEnv });
    } catch (error) {
      return installFailure('smoke', error, { clients, recovery });
    }

    const actionable = planned.filter(({ action }) => ['create', 'replace_unmanaged', 'update_managed'].includes(action));
    if (planned.length === 0 || actionable.length === 0) {
      for (const { adapter, action, managed } of planned) {
        if (action === 'conflict') {
          clients.push({ id: adapter.id, status: 'conflict', error: 'an unmanaged Goliath entry already exists or cannot be restored safely; use another client or remove it manually' });
        } else if (action === 'drift') {
          clients.push({ id: adapter.id, status: 'drift', error: 'the managed Goliath entry changed; refusing to overwrite it' });
        } else {
          try {
            await adapter.validate(managed.managedEntry);
            clients.push({ id: adapter.id, status: 'unchanged' });
          } catch (error) {
            clients.push({ id: adapter.id, status: 'drift', error: error.message });
          }
        }
      }
      const failed = clients.some((client) => ['conflict', 'drift', 'unsupported'].includes(client.status));
      return {
        schemaVersion: 1,
        status: failed ? 'partial' : (clients.length ? 'ready' : 'ready_unconfigured'),
        exitCode: failed ? 2 : 0,
        package: { name: PACKAGE_NAME, version },
        smoke,
        recovery,
        clients,
        genericMcp: clients.length ? undefined : genericMcpConfig(version),
      };
    }

    const runId = randomUUID();
    const records = actionable.map(({ adapter, action, current, managed }) => ({
      client: adapter.id,
      destination: adapter.configPath || null,
      action,
      beforeEntry: clone(current),
      afterEntry: clone(adapter.generatedEntry()),
      originalEntry: action === 'update_managed' ? clone(managed.originalEntry) : clone(current),
    }));
    let journal = writeJournal(paths, {
      runId,
      operation: 'install',
      records,
      appliedClients: [],
      priorState: clone(priorState),
      targetState: null,
    });
    await transactionBoundary(dependencies, 'after_journal_write', { runId });
    const changed = [];
    let unresolved = false;

    for (const { adapter, action } of planned) {
      if (action === 'conflict') {
        clients.push({ id: adapter.id, status: 'conflict', error: 'an unmanaged Goliath entry already exists or cannot be restored safely; refusing to replace it' });
        continue;
      }
      if (action === 'drift') {
        clients.push({ id: adapter.id, status: 'drift', error: 'the managed Goliath entry changed; refusing to overwrite it' });
        continue;
      }
      if (action === 'noop_managed') {
        const managed = priorState.clients[adapter.id];
        try {
          await adapter.validate(managed.managedEntry);
          clients.push({ id: adapter.id, status: 'unchanged' });
        } catch (error) {
          clients.push({ id: adapter.id, status: 'drift', error: error.message });
        }
        continue;
      }

      const record = records.find((item) => item.client === adapter.id);
      let currentBeforeApply;
      try {
        currentBeforeApply = await readAdapterEntry(adapter);
      } catch (error) {
        unresolved = true;
        clients.push({ id: adapter.id, status: 'recovery_required', error: `could not revalidate entry before mutation: ${error.message}` });
        continue;
      }
      if (!entriesEqual(currentBeforeApply, record.beforeEntry)) {
        record.beforeEntry = clone(currentBeforeApply);
        record.afterEntry = clone(currentBeforeApply);
        journal = writeJournal(paths, { ...journal, records });
        clients.push({ id: adapter.id, status: 'drift', error: `${adapter.id} entry changed after planning; preserved the newer value` });
        continue;
      }

      try {
        await adapter.apply(record.afterEntry, { replace: action !== 'create', expected: record.beforeEntry });
        await transactionBoundary(dependencies, 'after_adapter_apply', { runId, client: adapter.id });
        await adapter.validate(record.afterEntry);
        await transactionBoundary(dependencies, 'after_adapter_validate', { runId, client: adapter.id });
        journal = writeJournal(paths, { ...journal, appliedClients: [...journal.appliedClients, adapter.id] });
        changed.push({ adapter, record });
        await transactionBoundary(dependencies, 'after_journal_update', { runId, client: adapter.id });
        clients.push({ id: adapter.id, status: 'configured' });
      } catch (error) {
        if (isTestInterruption(error)) throw error;
        try {
          await reconcileRecord(adapter, record, 'beforeEntry');
          record.afterEntry = clone(record.beforeEntry);
          journal = writeJournal(paths, { ...journal, records });
          clients.push({ id: adapter.id, status: 'failed', error: error.message, restored: true });
        } catch (recoveryError) {
          unresolved = true;
          clients.push({ id: adapter.id, status: 'recovery_required', error: `${error.message}; ${recoveryError.message}` });
        }
      }
    }

    if (unresolved) {
      return installFailure('recovery_required', new Error('one or more harness entries could not be reconciled safely'), { clients, recovery });
    }

    const nextState = priorState ? clone(priorState) : initialState(version);
    nextState.package = { name: PACKAGE_NAME, version };
    nextState.lastSmokeTest = { ...smoke, at: new Date().toISOString() };
    for (const { adapter, record } of changed) {
      nextState.clients[adapter.id] = {
        identity: adapter.identity,
        version,
        configPath: adapter.configPath,
        action: record.action,
        managedEntry: clone(record.afterEntry),
        originalEntry: clone(record.originalEntry),
      };
    }
    journal = writeJournal(paths, { ...journal, targetState: nextState });
    await transactionBoundary(dependencies, 'before_state_write', { runId });
    try {
      writeHarnessState(paths, nextState);
      await transactionBoundary(dependencies, 'after_state_write', { runId });
      clearJournal(paths);
    } catch (error) {
      if (isTestInterruption(error)) throw error;
      try {
        const stateRecovery = await recoverJournalLocked(paths, readJournal(paths), adaptersById);
        return installFailure('state_commit', error, { clients, recovery: stateRecovery });
      } catch (recoveryError) {
        return installFailure('recovery_required', recoveryError, { clients });
      }
    }

    const failed = clients.some((client) => ['failed', 'conflict', 'drift', 'unsupported', 'recovery_required'].includes(client.status));
    const configured = clients.some((client) => ['configured', 'unchanged'].includes(client.status));
    return {
      schemaVersion: 1,
      status: failed ? 'partial' : (configured ? 'ready' : 'ready_unconfigured'),
      exitCode: failed ? 2 : 0,
      package: { name: PACKAGE_NAME, version },
      smoke,
      recovery,
      clients,
      genericMcp: configured ? undefined : genericMcpConfig(version),
      restart: clients.filter((client) => client.status === 'configured').map((client) => client.id),
    };
  } finally {
    lock.release();
  }
}

export async function upgradeHarnesses({ options = {}, dependencies = {} } = {}) {
  const home = dependencies.home || homedir();
  let state;
  try {
    state = readHarnessState(harnessInstallPaths(home));
  } catch (error) {
    return installFailure('managed_state', error);
  }
  if (!state) return installFailure('managed_state', new Error('no managed harness integration exists; run goliath install'));
  const clients = options.clients?.length ? options.clients : Object.keys(state.clients);
  return installHarnesses({ options: { ...options, clients }, dependencies: { ...dependencies, home } });
}

export async function uninstallHarnesses({ options = {}, dependencies = {} } = {}) {
  const home = dependencies.home || homedir();
  const paths = harnessInstallPaths(home);
  let state;
  try {
    state = readHarnessState(paths);
  } catch (error) {
    return installFailure('managed_state', error);
  }

  const version = dependencies.version || state?.package?.version || PACKAGE.version;
  const adapters = dependencies.adapters || createHarnessAdapters({ home, version, runCommand: dependencies.runCommand || runCommand });
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  let lock;
  try {
    lock = acquireHarnessInstallLock(paths, dependencies.lockOptions);
  } catch (error) {
    return installFailure('lock', error);
  }

  try {
    let recovery = null;
    try {
      const journal = readJournal(paths);
      if (journal) recovery = await recoverJournalLocked(paths, journal, byId);
      state = readHarnessState(paths);
    } catch (error) {
      return installFailure('recovery_required', error);
    }
    if (!state) return { schemaVersion: 1, status: 'removed', exitCode: 0, recovery, clients: [] };

    const targets = options.clients?.length ? options.clients : Object.keys(state.clients);
    const clients = [];
    const prepared = [];
    for (const id of targets) {
      const managed = state.clients[id];
      if (!managed) continue;
      const adapter = byId.get(id);
      if (!adapter) {
        clients.push({ id, status: 'conflict', error: 'adapter unavailable' });
        continue;
      }
      try {
        if (!Object.hasOwn(managed, 'managedEntry') || !Object.hasOwn(managed, 'originalEntry')) {
          throw new Error('managed ownership metadata is missing; refusing destructive uninstall');
        }
        const current = await readAdapterEntry(adapter);
        if (!entriesEqual(current, managed.managedEntry)) {
          throw new Error('the current entry no longer matches the exact Goliath-managed entry');
        }
        prepared.push({ adapter, managed, record: {
          client: id,
          destination: managed.configPath || adapter.configPath || null,
          action: 'uninstall',
          beforeEntry: clone(managed.managedEntry),
          afterEntry: clone(managed.originalEntry),
        } });
      } catch (error) {
        clients.push({ id, status: 'conflict', error: error.message });
      }
    }

    if (clients.some((client) => client.status === 'conflict')) {
      return { schemaVersion: 1, status: 'partial', exitCode: 2, recovery, clients };
    }
    if (prepared.length === 0) {
      return { schemaVersion: 1, status: 'removed', exitCode: 0, recovery, clients };
    }

    const targetState = clone(state);
    for (const { adapter } of prepared) delete targetState.clients[adapter.id];
    const runId = randomUUID();
    let journal = writeJournal(paths, {
      runId,
      operation: 'uninstall',
      records: prepared.map(({ record }) => record),
      appliedClients: [],
      priorState: clone(state),
      targetState,
    });
    await transactionBoundary(dependencies, 'after_journal_write', { runId, operation: 'uninstall' });

    try {
      for (const { adapter, record } of prepared) {
        await adapter.reconcile(record.beforeEntry, record.afterEntry);
        await transactionBoundary(dependencies, 'after_adapter_apply', { runId, client: adapter.id, operation: 'uninstall' });
        journal = writeJournal(paths, { ...journal, appliedClients: [...journal.appliedClients, adapter.id] });
        await transactionBoundary(dependencies, 'after_journal_update', { runId, client: adapter.id, operation: 'uninstall' });
        clients.push({ id: adapter.id, status: 'removed' });
      }
      await transactionBoundary(dependencies, 'before_state_write', { runId, operation: 'uninstall' });
      writeHarnessState(paths, targetState);
      await transactionBoundary(dependencies, 'after_state_write', { runId, operation: 'uninstall' });
      clearJournal(paths);
    } catch (error) {
      if (isTestInterruption(error)) throw error;
      try {
        const stateRecovery = await recoverJournalLocked(paths, readJournal(paths), byId);
        return installFailure('uninstall', error, { clients, recovery: stateRecovery });
      } catch (recoveryError) {
        return installFailure('recovery_required', recoveryError, { clients });
      }
    }

    return { schemaVersion: 1, status: 'removed', exitCode: 0, recovery, clients };
  } finally {
    lock.release();
  }
}

export function renderHarnessResult(result, { json = false } = {}) {
  if (json) return `${JSON.stringify(result)}\n`;
  if (result.status === 'removed') return 'Goliath managed harness configuration removed. Browser profiles and runtime were preserved.\n';
  if (result.status === 'planned') return `${JSON.stringify(result, null, 2)}\n`;
  if (result.status === 'ready' || result.status === 'ready_unconfigured') {
    const configured = (result.clients || []).filter((client) => client.status === 'configured').map((client) => client.id);
    return [
      'Goliath is ready for agent use.',
      `Configured: ${configured.length ? configured.join(', ') : 'no detected harnesses'}`,
      `MCP/browser/Hands smoke: ${result.smoke?.ok ? 'passed' : 'not run'}`,
      configured.length ? `Restart: ${configured.join(', ')}` : `Generic MCP config:\n${JSON.stringify(result.genericMcp, null, 2)}`,
      '',
    ].join('\n');
  }
  const errors = (result.errors || []).concat((result.clients || []).filter((client) => client.error).map((client) => `${client.id}: ${client.error}`));
  return `${result.status === 'partial' ? 'Goliath is ready, but some harness integrations need attention.' : 'Goliath harness installation failed.'}\n${errors.join('\n')}\n`;
}
