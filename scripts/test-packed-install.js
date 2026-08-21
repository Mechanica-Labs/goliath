#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'goliath-packed-install-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

try {
  const packDirectory = join(sandbox, 'pack');
  const prefix = join(sandbox, 'prefix');
  const home = join(sandbox, 'home');
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(home, { recursive: true });

  const packed = JSON.parse(run('npm', ['pack', ROOT, '--json', '--pack-destination', packDirectory]))[0];
  const tarball = join(packDirectory, packed.filename);
  const forbidden = packed.files.map((file) => file.path).filter((path) => (
    path.startsWith('tests/') ||
    path.startsWith('docs/') ||
    path.startsWith('.github/') ||
    path.includes('node_modules/') ||
    /(^|\/)\.env(?:\.|$)/.test(path) ||
    /(^|\/)(?:test-[^/]+|[^/]+\.(?:test|spec)\.[cm]?[jt]s)$/.test(path) ||
    /\.(?:tgz|zip|dmg|exe)$/.test(path) ||
    /(^|\/)camoufox-bin$/.test(path)
  ));
  if (forbidden.length) throw new Error(`forbidden tarball files: ${forbidden.join(', ')}`);

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball]);
  const packageRoot = join(prefix, 'node_modules', '@mechanica-labs', 'goliath');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@mechanica-labs/goliath' || manifest.version !== '0.1.0' || manifest.private !== false) {
    throw new Error('packed package identity mismatch');
  }
  const versionOutput = run(process.execPath, [join(packageRoot, 'bin', 'goliath.js'), '--version']).trim();
  if (versionOutput !== '0.1.0') throw new Error(`packed CLI reported ${versionOutput}`);

  const { harnessConfigs } = await import(pathToFileURL(join(packageRoot, 'lib', 'cli.js')));
  const { installHarnesses, uninstallHarnesses } = await import(pathToFileURL(join(packageRoot, 'lib', 'install', 'orchestrator.js')));
  const { entriesEqual, generatedMcpEntry } = await import(pathToFileURL(join(packageRoot, 'lib', 'install', 'adapters', 'base.js')));
  const { TOOL_NAMES } = await import(pathToFileURL(join(packageRoot, 'mcp', 'tool-contracts.mjs')));
  const generic = harnessConfigs().json.mcpServers.goliath;
  if (!generic.args.includes('@mechanica-labs/goliath@0.1.0')) throw new Error('packed harness config has the wrong npm identity');
  const declaredToolNames = manifest.openclaw.tools.map(tool => tool.name).sort();
  const contractToolNames = [...TOOL_NAMES].sort();
  if (
    !TOOL_NAMES.includes('goliath_hands') ||
    new Set(TOOL_NAMES).size !== TOOL_NAMES.length ||
    JSON.stringify(contractToolNames) !== JSON.stringify(declaredToolNames)
  ) {
    throw new Error(`packed public MCP contract is inconsistent (${TOOL_NAMES.length} tools)`);
  }

  const ids = ['codex', 'claude-code', 'cursor', 'hermes', 'openclaw'];
  const adapters = ids.map((id) => {
    const configPath = join(home, `${id}.json`);
    const generated = generatedMcpEntry(id, manifest.version);
    let current = null;
    return {
      id,
      identity: id,
      configPath,
      executable: id,
      generatedEntry: () => structuredClone(generated),
      currentEntry: async () => structuredClone(current),
      supportsReplacement: () => true,
      async apply(value = generated) {
        current = structuredClone(value);
        writeFileSync(configPath, JSON.stringify({ goliath: current }));
      },
      async validate(expected = generated) {
        if (!entriesEqual(current, expected) || !existsSync(configPath)) throw new Error(`${id} config mismatch`);
      },
      async reconcile(expected, replacement = null) {
        if (!entriesEqual(current, expected)) throw new Error(`${id} config drift`);
        current = structuredClone(replacement);
        if (replacement == null) rmSync(configPath, { force: true });
        else writeFileSync(configPath, JSON.stringify({ goliath: current }));
      },
    };
  });
  const config = {
    cookiesDir: join(home, '.goliath', 'cookies'),
    uploadsDir: join(home, '.goliath', 'uploads'),
    profileDir: join(home, '.goliath', 'profiles'),
    tracesDir: join(home, '.goliath', 'traces'),
  };
  const dependencies = {
    home,
    version: manifest.version,
    platform: process.platform === 'win32' ? 'linux' : process.platform,
    nodeVersion: process.version,
    config,
    adapters,
    detected: async () => true,
    ensureRuntime: async () => {},
    smoke: async () => ({ ok: true, tools: TOOL_NAMES.length, hands: true, exampleDomain: true }),
  };
  const installed = await installHarnesses({ options: {}, dependencies });
  if (installed.status !== 'ready' || installed.clients.filter((client) => client.status === 'configured').length !== ids.length) {
    throw new Error(`packed harness install failed: ${JSON.stringify(installed)}`);
  }
  const removed = await uninstallHarnesses({ dependencies });
  if (removed.status !== 'removed' || removed.clients.length !== ids.length) {
    throw new Error(`packed harness uninstall failed: ${JSON.stringify(removed)}`);
  }

  process.stdout.write(`Packed install passed: ${packed.entryCount} files, ${ids.length} harnesses, ${TOOL_NAMES.length} MCP tools including Hands\n`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
