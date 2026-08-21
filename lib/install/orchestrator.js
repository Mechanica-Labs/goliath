import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureBrowserInstalled } from '../browser-install.js';
import { loadConfig } from '../config.js';
import { createHarnessAdapters, genericMcpConfig } from './adapters/index.js';
import { backupFile, restoreBackup } from './files.js';
import { acquireHarnessInstallLock } from './lock.js';
import { harnessInstallPaths } from './paths.js';
import { runHarnessSmoke } from './smoke.js';
import {
  PACKAGE_NAME,
  clearJournal,
  readHarnessState,
  readJournal,
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

function existingEntry(adapter) {
  if (adapter.existingEntry) return adapter.existingEntry();
  if (!adapter.configPath || !existsSync(adapter.configPath)) return null;
  try {
    return /goliath/i.test(readFileSync(adapter.configPath, 'utf8')) ? { detected: true } : null;
  } catch {
    return { detected: true };
  }
}

function initialState(version) {
  return {
    schemaVersion: 1,
    package: { name: PACKAGE_NAME, version },
    clients: {},
    backups: [],
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

  let priorState;
  try {
    const journal = readJournal(paths);
    if (journal) return installFailure('recovery_required', new Error(`incomplete ${journal.operation} transaction ${journal.runId}`));
    priorState = readHarnessState(paths);
  } catch (error) {
    return installFailure('managed_state', error);
  }

  const adapterList = dependencies.adapters || createHarnessAdapters({
    home,
    version,
    runCommand: dependencies.runCommand || runCommand,
  });
  const requested = new Set(options.clients || []);
  const planned = [];
  const clients = [];

  if (!options.noConfig) {
    for (const adapter of adapterList) {
      if (requested.size && !requested.has(adapter.id)) continue;
      const detected = dependencies.detected ? await dependencies.detected(adapter) : defaultDetected(adapter, config.serverEnv?.PATH);
      if (!detected) {
        if (requested.has(adapter.id)) clients.push({ id: adapter.id, status: 'unsupported', error: `${adapter.id} was explicitly requested but was not detected` });
        continue;
      }

      const managed = priorState?.clients?.[adapter.id];
      let action = managed ? (managed.version === version ? 'noop_managed' : 'update_managed') : 'create';
      if (!managed && existingEntry(adapter)) action = options.replaceExisting ? 'replace_unmanaged' : 'conflict';
      planned.push({ adapter, action });
    }
  }

  if (options.dryRun) {
    const hasProblems = clients.length > 0 || planned.some(({ action }) => action === 'conflict');
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

  try {
    const ensureRuntime = dependencies.ensureRuntime || (() => ensureBrowserInstalled(config, dependencies.io));
    await ensureRuntime();
  } catch (error) {
    return installFailure('runtime', error, { clients });
  }

  let smoke;
  try {
    smoke = dependencies.smoke
      ? await dependencies.smoke()
      : await runHarnessSmoke({ environment: config.serverEnv });
  } catch (error) {
    return installFailure('smoke', error, { clients });
  }

  const actionable = planned.filter(({ action }) => !['noop_managed', 'conflict'].includes(action));
  if (planned.length === 0 || actionable.length === 0) {
    for (const { adapter, action } of planned) {
      if (action === 'conflict') {
        clients.push({ id: adapter.id, status: 'conflict', error: 'an unmanaged Goliath entry already exists; use --replace-existing with an explicit --client to replace it' });
      } else {
        try {
          await adapter.validate();
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
      clients,
      genericMcp: clients.length ? undefined : genericMcpConfig(version),
    };
  }

  const lock = acquireHarnessInstallLock(paths);
  const runId = randomUUID();
  const backupDirectory = join(paths.backups, runId);
  const backupRecords = actionable.map(({ adapter, action }) => ({
    client: adapter.id,
    destination: adapter.configPath || null,
    action,
    backup: backupFile(adapter.configPath, backupDirectory, `${adapter.id}-${basename(adapter.configPath || 'config')}`),
  }));
  let journal = writeJournal(paths, { runId, operation: 'install', backups: backupRecords, appliedClients: [] });
  const changed = [];

  try {
    for (const { adapter, action } of planned) {
      if (action === 'conflict') {
        clients.push({ id: adapter.id, status: 'conflict', error: 'an unmanaged Goliath entry already exists; use --replace-existing with an explicit --client to replace it' });
        continue;
      }
      if (action === 'noop_managed') {
        try {
          await adapter.validate();
          clients.push({ id: adapter.id, status: 'unchanged' });
        } catch (error) {
          clients.push({ id: adapter.id, status: 'drift', error: error.message });
        }
        continue;
      }

      const record = backupRecords.find((item) => item.client === adapter.id);
      try {
        await adapter.apply();
        await adapter.validate();
        changed.push({ adapter, record });
        journal = writeJournal(paths, { ...journal, appliedClients: [...journal.appliedClients, adapter.id] });
        clients.push({ id: adapter.id, status: 'configured', backup: record.backup.path });
      } catch (error) {
        try {
          await adapter.remove();
        } catch {
          // The original config backup remains the authoritative rollback.
        }
        restoreBackup(record.backup, record.destination);
        clients.push({ id: adapter.id, status: 'failed', error: error.message, restored: true });
      }
    }

    const nextState = priorState || initialState(version);
    nextState.package = { name: PACKAGE_NAME, version };
    nextState.lastSmokeTest = { ...smoke, at: new Date().toISOString() };
    for (const { adapter, record } of changed) {
      nextState.clients[adapter.id] = {
        identity: adapter.identity,
        version,
        configPath: adapter.configPath,
        action: record.action,
        backup: record.backup,
      };
      if (record.backup.path) nextState.backups.push(record.backup.path);
    }
    writeHarnessState(paths, nextState);
    clearJournal(paths);
  } catch (error) {
    for (const { adapter, record } of changed.reverse()) {
      try { await adapter.remove(); } catch { /* rollback continues */ }
      restoreBackup(record.backup, record.destination);
    }
    return installFailure('state_commit', error, { clients, restored: true });
  } finally {
    lock.release();
  }

  const failed = clients.some((client) => ['failed', 'conflict', 'drift', 'unsupported'].includes(client.status));
  const configured = clients.some((client) => ['configured', 'unchanged'].includes(client.status));
  return {
    schemaVersion: 1,
    status: failed ? 'partial' : (configured ? 'ready' : 'ready_unconfigured'),
    exitCode: failed ? 2 : 0,
    package: { name: PACKAGE_NAME, version },
    smoke,
    clients,
    genericMcp: configured ? undefined : genericMcpConfig(version),
    restart: clients.filter((client) => client.status === 'configured').map((client) => client.id),
  };
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
    if (readJournal(paths)) return installFailure('recovery_required', new Error('an incomplete harness installer transaction requires recovery'));
    state = readHarnessState(paths);
  } catch (error) {
    return installFailure('managed_state', error);
  }
  if (!state) return { schemaVersion: 1, status: 'removed', exitCode: 0, clients: [] };

  const version = dependencies.version || state.package.version;
  const adapters = dependencies.adapters || createHarnessAdapters({ home, version, runCommand: dependencies.runCommand || runCommand });
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const targets = options.clients?.length ? options.clients : Object.keys(state.clients);
  const clients = [];
  const lock = acquireHarnessInstallLock(paths);
  try {
    for (const id of targets) {
      const managed = state.clients[id];
      if (!managed) continue;
      const adapter = byId.get(id);
      if (!adapter) {
        clients.push({ id, status: 'conflict', error: 'adapter unavailable' });
        continue;
      }
      try {
        await adapter.validate();
        await adapter.remove();
        if (managed.action === 'replace_unmanaged') restoreBackup(managed.backup, managed.configPath);
        delete state.clients[id];
        clients.push({ id, status: 'removed' });
      } catch (error) {
        clients.push({ id, status: 'conflict', error: error.message });
      }
    }
    writeHarnessState(paths, state);
  } finally {
    lock.release();
  }

  const failed = clients.some((client) => client.status === 'conflict');
  return { schemaVersion: 1, status: failed ? 'partial' : 'removed', exitCode: failed ? 2 : 0, clients };
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
