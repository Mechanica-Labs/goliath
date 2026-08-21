import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, jest, test } from '@jest/globals';

import { claudeCodeAdapter } from '../../lib/install/adapters/claude-code.js';
import { codexAdapter } from '../../lib/install/adapters/codex.js';
import { cursorAdapter } from '../../lib/install/adapters/cursor.js';
import { entriesEqual, generatedMcpEntry, makeCommandAdapter } from '../../lib/install/adapters/base.js';
import { hermesAdapter } from '../../lib/install/adapters/hermes.js';
import { openClawAdapter } from '../../lib/install/adapters/openclaw.js';
import { atomicWrite } from '../../lib/install/files.js';
import { acquireHarnessInstallLock } from '../../lib/install/lock.js';
import { installHarnesses, uninstallHarnesses } from '../../lib/install/orchestrator.js';
import { parseHarnessInstallArgs } from '../../lib/install/options.js';
import { harnessInstallPaths } from '../../lib/install/paths.js';
import { readHarnessState, readJournal } from '../../lib/install/state.js';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'goliath-harness-install-'));
  roots.push(home);
  return home;
}

function dependencies(home, adapters = []) {
  return {
    home,
    version: '0.1.0',
    platform: 'darwin',
    nodeVersion: 'v22.1.0',
    config: { serverEnv: {} },
    adapters,
    detected: async () => true,
    ensureRuntime: jest.fn(async () => {}),
    smoke: jest.fn(async () => ({ ok: true, tools: 15, hands: true, exampleDomain: true })),
  };
}

function memoryAdapter(home, id, { initial = null, generated = generatedMcpEntry(id, '0.1.0') } = {}) {
  let current = structuredClone(initial);
  const adapter = {
    id,
    identity: id,
    executable: id,
    configPath: join(home, `${id}.json`),
    generatedEntry: () => structuredClone(generated),
    currentEntry: async () => structuredClone(current),
    supportsReplacement: () => true,
    async apply(value = generated) { current = structuredClone(value); },
    async validate(expected = generated) {
      if (!entriesEqual(current, expected)) throw new Error(`${id} drift`);
    },
    async reconcile(expected, replacement = null) {
      if (!entriesEqual(current, expected)) throw new Error(`${id} drift`);
      current = structuredClone(replacement);
    },
    setCurrent(value) { current = structuredClone(value); },
  };
  return adapter;
}

function commandMemoryAdapter(home, id, { initial = null } = {}) {
  const generated = generatedMcpEntry(id, '0.1.0');
  let current = structuredClone(initial);
  let interruptAfterRemove = false;
  const adapter = makeCommandAdapter({
    id,
    identity: id,
    executable: id,
    version: '0.1.0',
    entry: generated,
    configPath: join(home, `${id}.json`),
    add: value => ['add', JSON.stringify(value)],
    remove: () => ['remove'],
    read: () => ['read'],
    parse: output => JSON.parse(output),
    missing: () => false,
    canRestore: () => true,
    runCommand: async argv => {
      if (argv[0] === 'read') return JSON.stringify(current);
      if (argv[0] === 'remove') {
        current = null;
        if (interruptAfterRemove) throw interrupt();
        return '';
      }
      if (argv[0] === 'add') {
        current = JSON.parse(argv[1]);
        return '';
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  });
  adapter.setInterruptAfterRemove = value => { interruptAfterRemove = value; };
  return adapter;
}

function interrupt() {
  const error = new Error('simulated abrupt process interruption');
  error.code = 'GOLIATH_TEST_INTERRUPT';
  return error;
}

test('generated MCP entries use the public package identity and stable harness user', () => {
  expect(generatedMcpEntry('codex', '0.1.0')).toEqual({
    command: 'npx',
    args: ['-y', '@mechanica-labs/goliath@0.1.0', 'mcp'],
    env: { GOLIATH_USER_ID: 'codex' },
  });
});

test('installer options require an explicit client before replacing an unmanaged entry', () => {
  expect(parseHarnessInstallArgs(['--client', 'codex,cursor', '--replace-existing', '--dry-run'])).toEqual({
    clients: ['codex', 'cursor'],
    replaceExisting: true,
    dryRun: true,
    noConfig: false,
    json: false,
  });
  expect(() => parseHarnessInstallArgs(['--replace-existing'])).toThrow('--client');
  expect(() => parseHarnessInstallArgs(['--client', 'unknown'])).toThrow('unknown client');
});

test('dry run discovers harnesses without runtime, smoke, files, or state mutation', async () => {
  const home = fixture();
  const adapter = memoryAdapter(home, 'codex');
  const deps = dependencies(home, [adapter]);
  const result = await installHarnesses({ options: { dryRun: true }, dependencies: deps });
  expect(result).toMatchObject({ status: 'planned', clients: [{ id: 'codex', status: 'create' }] });
  expect(deps.ensureRuntime).not.toHaveBeenCalled();
  expect(deps.smoke).not.toHaveBeenCalled();
  expect(existsSync(harnessInstallPaths(home).root)).toBe(false);
});

test('dry run reports unmanaged configuration conflicts without mutating them', async () => {
  const home = fixture();
  const original = { command: 'custom', args: [], env: {} };
  const adapter = memoryAdapter(home, 'codex', { initial: original });
  const result = await installHarnesses({ options: { dryRun: true }, dependencies: dependencies(home, [adapter]) });
  expect(result).toMatchObject({ exitCode: 2, clients: [{ id: 'codex', status: 'conflict' }] });
  expect(await adapter.currentEntry()).toEqual(original);
});

test('live smoke completes before the first harness mutation', async () => {
  const home = fixture();
  const order = [];
  const adapter = memoryAdapter(home, 'codex');
  const apply = adapter.apply.bind(adapter);
  const validate = adapter.validate.bind(adapter);
  adapter.apply = async (...args) => { order.push('apply'); return apply(...args); };
  adapter.validate = async (...args) => { order.push('validate'); return validate(...args); };
  const deps = dependencies(home, [adapter]);
  deps.smoke = async () => { order.push('smoke'); return { ok: true, tools: 15, hands: true }; };
  const result = await installHarnesses({ dependencies: deps });
  expect(result.status).toBe('ready');
  expect(order).toEqual(['smoke', 'apply', 'validate']);
  expect(readHarnessState(harnessInstallPaths(home)).package).toEqual({ name: '@mechanica-labs/goliath', version: '0.1.0' });
  for (const directory of ['cookies', 'uploads', 'profiles', 'traces']) {
    expect(existsSync(join(home, '.goliath', directory))).toBe(false);
  }
});

test('failed harness mutation reconciles only its entry to the original value', async () => {
  const home = fixture();
  const original = { command: 'original', args: ['one'], env: {} };
  const adapter = memoryAdapter(home, 'cursor', { initial: original });
  const apply = adapter.apply.bind(adapter);
  adapter.apply = async (value) => { await apply(value); throw new Error('apply failed'); };
  const result = await installHarnesses({
    options: { clients: ['cursor'], replaceExisting: true },
    dependencies: dependencies(home, [adapter]),
  });
  expect(result.status).toBe('partial');
  expect(await adapter.currentEntry()).toEqual(original);
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
});

test('installer refuses an entry changed after planning and preserves the new user value', async () => {
  const home = fixture();
  const original = { command: 'original', args: [], env: {} };
  const changed = { command: 'changed-during-smoke', args: [], env: {} };
  const adapter = memoryAdapter(home, 'cursor', { initial: original });
  const deps = dependencies(home, [adapter]);
  deps.smoke = async () => {
    adapter.setCurrent(changed);
    return { ok: true, tools: 15, hands: true };
  };
  const result = await installHarnesses({
    options: { clients: ['cursor'], replaceExisting: true },
    dependencies: deps,
  });
  expect(result.status).toBe('partial');
  expect(await adapter.currentEntry()).toEqual(changed);
  expect(result.clients[0]).toMatchObject({ id: 'cursor', status: 'drift' });
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
});

test('uninstall proves exact ownership and refuses a drifted managed entry', async () => {
  const home = fixture();
  const adapter = memoryAdapter(home, 'codex');
  const deps = dependencies(home, [adapter]);
  expect((await installHarnesses({ dependencies: deps })).status).toBe('ready');
  adapter.setCurrent({ ...adapter.generatedEntry(), args: ['user-owned-command'] });
  const reconcile = jest.spyOn(adapter, 'reconcile');
  const result = await uninstallHarnesses({ dependencies: deps });
  expect(result).toMatchObject({ status: 'partial', clients: [{ id: 'codex', status: 'conflict' }] });
  expect(reconcile).not.toHaveBeenCalled();
});

test('uninstall removes only exact managed entries and keeps Goliath data', async () => {
  const home = fixture();
  const adapter = memoryAdapter(home, 'cursor');
  const deps = dependencies(home, [adapter]);
  expect((await installHarnesses({ dependencies: deps })).status).toBe('ready');
  const result = await uninstallHarnesses({ dependencies: deps });
  expect(result.status).toBe('removed');
  expect(result.clients).toEqual([{ id: 'cursor', status: 'removed' }]);
  expect(readHarnessState(harnessInstallPaths(home)).clients).toEqual({});
  expect(existsSync(join(home, '.goliath'))).toBe(true);
});

test('all reviewed native adapters reject structurally drifted entries before removal', async () => {
  const home = fixture();
  const cases = [];

  let codexCurrent;
  let codexRemovals = 0;
  const codex = codexAdapter({ home, version: '0.1.0', runCommand: async (argv) => {
    if (argv.includes('get')) {
      return JSON.stringify({
        transport: { type: 'stdio', command: codexCurrent.command, args: codexCurrent.args, env: codexCurrent.env, cwd: codexCurrent.cwd },
        enabled_tools: codexCurrent.enabledTools,
        disabled_tools: codexCurrent.disabledTools,
        startup_timeout_sec: codexCurrent.startupTimeoutSec,
        tool_timeout_sec: codexCurrent.toolTimeoutSec,
      });
    }
    if (argv.includes('remove')) codexRemovals += 1;
    return '';
  } });
  const codexExpected = codex.generatedEntry();
  codexCurrent = { ...codexExpected, args: ['user-owned'] };
  cases.push({ adapter: codex, expected: codexExpected, removals: () => codexRemovals });

  const claude = claudeCodeAdapter({ home, version: '0.1.0', runCommand: async () => '' });
  mkdirSync(dirname(claude.configPath), { recursive: true });
  const claudeExpected = claude.generatedEntry();
  writeFileSync(claude.configPath, JSON.stringify({ mcpServers: { goliath: { ...claudeExpected, command: 'user-owned' } } }));
  cases.push({ adapter: claude, expected: claudeExpected });

  const hermes = hermesAdapter({ home, version: '0.1.0' });
  mkdirSync(dirname(hermes.configPath), { recursive: true });
  const hermesExpected = hermes.generatedEntry();
  writeFileSync(hermes.configPath, `mcp_servers:\n  goliath:\n    command: user-owned\n    args: []\n    env: {}\n`);
  cases.push({ adapter: hermes, expected: hermesExpected });

  let openClawRemovals = 0;
  const openclaw = openClawAdapter({ home, version: '0.1.0', runCommand: async (argv) => {
    if (argv.includes('inspect')) return JSON.stringify({ plugin: { id: 'goliath-browser', packageName: '@someone/else', version: '9.9.9' } });
    if (argv.includes('uninstall')) openClawRemovals += 1;
    return '';
  } });
  cases.push({ adapter: openclaw, expected: openclaw.generatedEntry(), removals: () => openClawRemovals });

  for (const item of cases) {
    await expect(item.adapter.reconcile(item.expected, null)).rejects.toThrow(/drifted/);
    expect(item.removals?.() || 0).toBe(0);
  }
});

test('native command adapters use the corrected Claude argument order and OpenClaw plugin id', async () => {
  const home = fixture();
  let claudeCommand;
  const claude = claudeCodeAdapter({ home, version: '0.1.0', runCommand: async (argv) => { claudeCommand = argv; } });
  await claude.apply();
  expect(claudeCommand).toEqual([
    'claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'goliath',
    '-e', 'GOLIATH_USER_ID=claude-code', '--', 'npx', '-y', '@mechanica-labs/goliath@0.1.0', 'mcp',
  ]);

  let installed = true;
  const commands = [];
  const openclaw = openClawAdapter({ home, version: '0.1.0', runCommand: async (argv) => {
    commands.push(argv);
    if (argv.includes('inspect')) {
      if (!installed) {
        const error = new Error('Plugin not found: goliath-browser');
        error.stderr = 'Plugin not found: goliath-browser';
        throw error;
      }
      return JSON.stringify({ plugin: { id: 'goliath-browser', packageName: '@mechanica-labs/goliath', version: '0.1.0' } });
    }
    if (argv.includes('uninstall')) installed = false;
    return '';
  } });
  await openclaw.reconcile(openclaw.generatedEntry(), null);
  expect(commands.some((argv) => argv.join(' ') === 'openclaw plugins uninstall --force goliath-browser')).toBe(true);
});

test('entry-level uninstall restores only the replaced Goliath entry and preserves later edits', async () => {
  const home = fixture();
  mkdirSync(join(home, '.cursor'), { mode: 0o755 });
  const configPath = join(home, '.cursor', 'mcp.json');
  const original = { command: 'original-server', args: ['--keep'], env: { ORIGINAL: '1' } };
  writeFileSync(configPath, `${JSON.stringify({ theme: 'dark', mcpServers: { goliath: original, other: { command: 'other' } } }, null, 2)}\n`);
  const adapter = cursorAdapter({ home, version: '0.1.0' });
  const deps = dependencies(home, [adapter]);
  expect((await installHarnesses({ options: { clients: ['cursor'], replaceExisting: true }, dependencies: deps })).status).toBe('ready');

  const afterInstall = JSON.parse(readFileSync(configPath, 'utf8'));
  afterInstall.addedAfterInstall = { survives: true };
  afterInstall.mcpServers.other.setting = 'also-survives';
  writeFileSync(configPath, `${JSON.stringify(afterInstall, null, 2)}\n`);

  expect((await uninstallHarnesses({ dependencies: deps })).status).toBe('removed');
  const final = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(final.mcpServers.goliath).toEqual(original);
  expect(final.mcpServers.other).toEqual({ command: 'other', setting: 'also-survives' });
  expect(final.addedAfterInstall).toEqual({ survives: true });
});

test.each([
  'after_journal_write',
  'after_adapter_apply',
  'after_adapter_validate',
  'after_journal_update',
  'before_state_write',
  'after_state_write',
])('interrupted install recovers idempotently at %s', async (boundary) => {
  const home = fixture();
  const adapter = memoryAdapter(home, 'codex');
  const deps = dependencies(home, [adapter]);
  let fired = false;
  deps.onTransactionBoundary = async (stage) => {
    if (!fired && stage === boundary) {
      fired = true;
      throw interrupt();
    }
  };
  await expect(installHarnesses({ dependencies: deps })).rejects.toThrow('simulated abrupt');
  expect(readJournal(harnessInstallPaths(home))).not.toBeNull();

  delete deps.onTransactionBoundary;
  const recovered = await installHarnesses({ dependencies: deps });
  expect(recovered.status).toBe('ready');
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
  expect(await adapter.currentEntry()).toEqual(adapter.generatedEntry());

  const repeated = await installHarnesses({ dependencies: deps });
  expect(repeated.status).toBe('ready');
  expect(repeated.clients).toEqual([{ id: 'codex', status: 'unchanged' }]);
});

test('multi-client partial mutation is rolled back before a deterministic retry', async () => {
  const home = fixture();
  const first = memoryAdapter(home, 'codex');
  const second = memoryAdapter(home, 'cursor');
  const deps = dependencies(home, [first, second]);
  deps.onTransactionBoundary = async (stage, context) => {
    if (stage === 'after_journal_update' && context.client === 'codex') throw interrupt();
  };
  await expect(installHarnesses({ dependencies: deps })).rejects.toThrow('simulated abrupt');
  expect(await first.currentEntry()).toEqual(first.generatedEntry());
  expect(await second.currentEntry()).toBeNull();

  delete deps.onTransactionBoundary;
  const result = await installHarnesses({ dependencies: deps });
  expect(result.status).toBe('ready');
  expect(result.clients.filter((client) => client.status === 'configured')).toHaveLength(2);
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
});

test('interrupted uninstall rolls back safely and can be retried', async () => {
  const home = fixture();
  const adapter = memoryAdapter(home, 'codex');
  const deps = dependencies(home, [adapter]);
  expect((await installHarnesses({ dependencies: deps })).status).toBe('ready');
  deps.onTransactionBoundary = async (stage, context) => {
    if (stage === 'after_adapter_apply' && context.operation === 'uninstall') throw interrupt();
  };
  await expect(uninstallHarnesses({ dependencies: deps })).rejects.toThrow('simulated abrupt');
  expect(await adapter.currentEntry()).toBeNull();

  delete deps.onTransactionBoundary;
  const result = await uninstallHarnesses({ dependencies: deps });
  expect(result.status).toBe('removed');
  expect(await adapter.currentEntry()).toBeNull();
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
});

test.each([
  ['created entry', null],
  ['replaced entry', { command: 'original', args: ['--keep'], env: { ORIGINAL: '1' } }],
])('command adapter recovers an interrupted remove/add for a %s', async (_label, original) => {
  const home = fixture();
  const adapter = commandMemoryAdapter(home, 'codex', { initial: original });
  const deps = dependencies(home, [adapter]);
  const options = original == null ? {} : { clients: ['codex'], replaceExisting: true };
  expect((await installHarnesses({ options, dependencies: deps })).status).toBe('ready');

  adapter.setInterruptAfterRemove(true);
  await expect(uninstallHarnesses({ dependencies: deps })).rejects.toThrow('simulated abrupt');
  expect(await adapter.currentEntry()).toBeNull();
  expect(readJournal(harnessInstallPaths(home))).not.toBeNull();

  adapter.setInterruptAfterRemove(false);
  const recovered = await uninstallHarnesses({ dependencies: deps });
  expect(recovered.status).toBe('removed');
  expect(await adapter.currentEntry()).toEqual(original);
  expect(readJournal(harnessInstallPaths(home))).toBeNull();
});

test('lock acquisition never replaces a fresh empty lock or a live owner', () => {
  const home = fixture();
  const paths = harnessInstallPaths(home);
  mkdirSync(dirname(paths.lock), { recursive: true, mode: 0o700 });
  writeFileSync(paths.lock, '');
  expect(() => acquireHarnessInstallLock(paths, { pid: 199, staleMs: 60_000 })).toThrow(/acquiring the lock/);
  expect(statSync(paths.lock).isFile()).toBe(true);

  rmSync(paths.lock, { force: true });
  mkdirSync(paths.lock, { recursive: true, mode: 0o700 });
  expect(() => acquireHarnessInstallLock(paths, { pid: 200, staleMs: 60_000 })).toThrow(/acquiring the lock/);
  expect(existsSync(paths.lock)).toBe(true);

  rmSync(paths.lock, { recursive: true, force: true });
  const first = acquireHarnessInstallLock(paths, { pid: 201, isAlive: () => true });
  expect(() => acquireHarnessInstallLock(paths, { pid: 202, isAlive: () => true })).toThrow(/another Goliath harness install/);
  first.release();
  const second = acquireHarnessInstallLock(paths, { pid: 202, isAlive: () => true });
  second.release();
});

test('a contender can acquire while another owner candidate is unpublished without creating two locks', () => {
  const home = fixture();
  const paths = harnessInstallPaths(home);
  let contender;
  expect(() => acquireHarnessInstallLock(paths, {
    pid: 301,
    isAlive: () => true,
    onCandidateReady: () => {
      contender = acquireHarnessInstallLock(paths, { pid: 302, isAlive: () => true });
    },
  })).toThrow(/another Goliath harness install/);
  expect(contender).toBeDefined();
  expect(() => acquireHarnessInstallLock(paths, { pid: 303, isAlive: () => true })).toThrow(/another Goliath harness install/);
  contender.release();
});

test('two stale-lock contenders fail closed without deleting or replacing the observed lock', () => {
  const home = fixture();
  const paths = harnessInstallPaths(home);
  mkdirSync(dirname(paths.lock), { recursive: true, mode: 0o700 });
  const staleOwner = { pid: 401, token: 'stale-owner-token', startedAt: '2020-01-01T00:00:00.000Z' };
  writeFileSync(paths.lock, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });

  let secondError;
  expect(() => acquireHarnessInstallLock(paths, {
    pid: 402,
    isAlive: () => {
      try {
        acquireHarnessInstallLock(paths, { pid: 403, isAlive: () => false, staleMs: 0 });
      } catch (error) {
        secondError = error;
      }
      return false;
    },
    staleMs: 0,
  })).toThrow(/stale Goliath harness install lock/);

  expect(secondError?.message).toMatch(/stale Goliath harness install lock/);
  expect(JSON.parse(readFileSync(paths.lock, 'utf8'))).toEqual(staleOwner);
});

test('atomic writes preserve permissions on an existing harness directory', () => {
  const home = fixture();
  const directory = join(home, '.cursor');
  mkdirSync(directory, { mode: 0o755 });
  chmodSync(directory, 0o755);
  atomicWrite(join(directory, 'mcp.json'), '{}\n');
  expect(statSync(directory).mode & 0o777).toBe(0o755);
});
