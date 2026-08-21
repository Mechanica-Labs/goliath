import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, jest, test } from '@jest/globals';

import { generatedMcpEntry } from '../../lib/install/adapters/base.js';
import { installHarnesses, uninstallHarnesses } from '../../lib/install/orchestrator.js';
import { parseHarnessInstallArgs } from '../../lib/install/options.js';
import { harnessInstallPaths } from '../../lib/install/paths.js';
import { readHarnessState, writeHarnessState } from '../../lib/install/state.js';

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
    config: {
      cookiesDir: join(home, '.goliath', 'cookies'),
      uploadsDir: join(home, '.goliath', 'uploads'),
      profileDir: join(home, '.goliath', 'profiles'),
      tracesDir: join(home, '.goliath', 'traces'),
    },
    adapters,
    detected: async () => true,
    ensureRuntime: jest.fn(async () => {}),
    smoke: jest.fn(async () => ({ ok: true, tools: 15, hands: true, exampleDomain: true })),
  };
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
  const adapter = { id: 'codex', executable: 'codex', configPath: join(home, '.codex', 'config.toml') };
  const deps = dependencies(home, [adapter]);
  const result = await installHarnesses({ options: { dryRun: true }, dependencies: deps });
  expect(result).toMatchObject({ status: 'planned', clients: [{ id: 'codex', status: 'create' }] });
  expect(deps.ensureRuntime).not.toHaveBeenCalled();
  expect(deps.smoke).not.toHaveBeenCalled();
  expect(existsSync(harnessInstallPaths(home).root)).toBe(false);
});

test('dry run reports unmanaged configuration conflicts without mutating them', async () => {
  const home = fixture();
  const configPath = join(home, 'codex.json');
  writeFileSync(configPath, '{"goliath":"unmanaged"}');
  const adapter = { id: 'codex', executable: 'codex', configPath };
  const result = await installHarnesses({ options: { dryRun: true }, dependencies: dependencies(home, [adapter]) });
  expect(result).toMatchObject({ exitCode: 2, clients: [{ id: 'codex', status: 'conflict' }] });
  expect(readFileSync(configPath, 'utf8')).toBe('{"goliath":"unmanaged"}');
});

test('live smoke completes before the first harness mutation', async () => {
  const home = fixture();
  const order = [];
  const configPath = join(home, 'codex.json');
  const adapter = {
    id: 'codex', identity: 'codex', executable: 'codex', configPath,
    async apply() { order.push('apply'); writeFileSync(configPath, '{}'); },
    async validate() { order.push('validate'); },
    async remove() { rmSync(configPath, { force: true }); },
  };
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

test('failed harness mutation restores the original configuration', async () => {
  const home = fixture();
  const configPath = join(home, 'cursor.json');
  writeFileSync(configPath, 'original goliath configuration');
  const adapter = {
    id: 'cursor', identity: 'cursor', configPath,
    existingEntry: () => ({ detected: true }),
    async apply() { writeFileSync(configPath, 'broken'); throw new Error('apply failed'); },
    async validate() {},
    async remove() { rmSync(configPath, { force: true }); },
  };
  const result = await installHarnesses({
    options: { clients: ['cursor'], replaceExisting: true },
    dependencies: dependencies(home, [adapter]),
  });
  expect(result.status).toBe('partial');
  expect(readFileSync(configPath, 'utf8')).toBe('original goliath configuration');
});

test('uninstall removes only managed harnesses and keeps Goliath data', async () => {
  const home = fixture();
  const paths = harnessInstallPaths(home);
  const configPath = join(home, 'cursor.json');
  writeFileSync(configPath, '{}');
  writeHarnessState(paths, {
    schemaVersion: 1,
    package: { name: '@mechanica-labs/goliath', version: '0.1.0' },
    clients: { cursor: { identity: 'cursor', version: '0.1.0', configPath, action: 'create', backup: { existed: false, path: null } } },
    backups: [],
    lastSmokeTest: { ok: true },
  });
  const remove = jest.fn(async () => rmSync(configPath, { force: true }));
  const result = await uninstallHarnesses({
    dependencies: {
      home,
      adapters: [{ id: 'cursor', configPath, validate: async () => {}, remove }],
    },
  });
  expect(result.status).toBe('removed');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(readHarnessState(paths).clients).toEqual({});
  expect(existsSync(join(home, '.goliath'))).toBe(true);
});
