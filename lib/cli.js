import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { ensureBrowserInstalled } from './browser-install.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

function write(stream, value = '') {
  stream.write(`${value}\n`);
}

export function harnessConfigs(version = PACKAGE.version) {
  const npmPackage = `${PACKAGE.name}@${version}`;
  return {
    json: {
      mcpServers: {
        goliath: {
          command: 'npx',
          args: ['-y', npmPackage, 'mcp'],
          env: {
            GOLIATH_USER_ID: 'my-agent',
          },
        },
      },
    },
    hermes: [
      'mcp_servers:',
      '  goliath:',
      '    command: "npx"',
      `    args: ["-y", "${npmPackage}", "mcp"]`,
      '    env:',
      '      GOLIATH_USER_ID: "my-agent"',
    ].join('\n'),
  };
}

function browserStatus(config) {
  if (config.camoufoxExecutablePath) {
    try {
      accessSync(config.camoufoxExecutablePath, constants.X_OK);
      return { status: 'ok', detail: `external executable: ${config.camoufoxExecutablePath}` };
    } catch {
      return { status: 'error', detail: `configured executable is missing or not executable: ${config.camoufoxExecutablePath}` };
    }
  }

  const versionFile = join(config.camoufoxCacheDir, 'version.json');
  if (!existsSync(versionFile)) {
    return { status: 'error', detail: 'browser engine is not installed; run: goliath setup' };
  }
  try {
    const version = JSON.parse(readFileSync(versionFile, 'utf8'));
    return { status: 'ok', detail: `Camoufox ${version.version || 'installed'}${version.release ? ` (${version.release})` : ''}` };
  } catch {
    return { status: 'warn', detail: `browser cache exists but ${versionFile} could not be parsed` };
  }
}

async function serverStatus(config) {
  const baseUrl = config.mcpBaseUrl || `http://127.0.0.1:${config.port}`;
  try {
    const headers = config.accessKey ? { Authorization: `Bearer ${config.accessKey}` } : {};
    const response = await fetch(`${baseUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { status: 'warn', detail: `${baseUrl} returned HTTP ${response.status}` };
    const health = await response.json();
    return { status: 'ok', detail: `${baseUrl} (${health.engine || health.status || 'ready'})` };
  } catch {
    return { status: 'info', detail: `${baseUrl} is stopped; the MCP bridge will start it automatically` };
  }
}

export async function collectDoctor(config = loadConfig()) {
  const major = Number(process.versions.node.split('.')[0]);
  const checks = [
    {
      name: 'Node.js',
      status: major >= 22 ? 'ok' : 'error',
      detail: `${process.version}${major >= 22 ? '' : ' (Node 22 or newer is required)'}`,
    },
    { name: 'Browser', ...browserStatus(config) },
  ];

  for (const [name, path] of [
    ['Uploads', config.uploadsDir],
    ['Profiles', config.profileDir],
  ]) {
    checks.push({
      name,
      status: existsSync(path) ? 'ok' : 'warn',
      detail: existsSync(path) ? path : `${path} is missing; run: goliath setup`,
    });
  }
  checks.push({ name: 'Server', ...(await serverStatus(config)) });

  return {
    name: PACKAGE.name,
    version: PACKAGE.version,
    ready: !checks.some((check) => check.status === 'error'),
    checks,
  };
}

function printDoctor(report, stdout) {
  write(stdout, `Goliath ${report.version}`);
  for (const check of report.checks) {
    const marker = check.status === 'ok' ? '✓' : check.status === 'error' ? '✗' : '•';
    write(stdout, `${marker} ${check.name}: ${check.detail}`);
  }
  write(stdout, report.ready ? 'Ready for agent use.' : 'Not ready. Fix the errors above and run goliath doctor again.');
}

function setupDirectories(config) {
  const directories = [config.cookiesDir, config.uploadsDir, config.profileDir, config.tracesDir];
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directories;
}

function helpText() {
  return [
    `Goliath ${PACKAGE.version} — browser hands for AI agents`,
    '',
    'Usage: goliath [command]',
    '',
    'Commands:',
    '  serve          Start the local REST server (default)',
    '  mcp            Start the stdio MCP bridge and auto-start the server',
    '  setup          Create local data directories and print harness config',
    '  doctor         Check Node, browser engine, directories, and server',
    '  up             Start a health-checked background server',
    '  down           Stop the managed background server',
    '  restart        Restart the managed background server',
    '  status         Show managed background server status',
    '  logs           Show managed background server logs (-f to follow)',
    '  --version      Print the installed version',
    '  --help         Show this help',
  ].join('\n');
}

export async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const command = argv[0] || 'serve';
  if (command === '--help' || command === '-h' || command === 'help') {
    write(io.stdout, helpText());
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    write(io.stdout, PACKAGE.version);
    return;
  }
  if (command === 'serve' || command === 'start') {
    try {
      await ensureBrowserInstalled(loadConfig(), { stdout: io.stdout, stderr: io.stderr });
    } catch (error) {
      write(io.stderr, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    await import('../server.js');
    return;
  }
  if (command === 'mcp') {
    await import('../mcp/server.mjs');
    return;
  }
  if (command === 'doctor') {
    const report = await collectDoctor();
    if (argv.includes('--json')) write(io.stdout, JSON.stringify(report, null, 2));
    else printDoctor(report, io.stdout);
    if (!report.ready) process.exitCode = 1;
    return;
  }
  if (command === 'setup') {
    const config = loadConfig();
    const directories = setupDirectories(config);
    const formats = harnessConfigs();
    const requestedFormat = argv.includes('--json') ? 'json' : argv.includes('--hermes') ? 'hermes' : 'all';
    try {
      await ensureBrowserInstalled(config, {
        stdout: requestedFormat === 'all' ? io.stdout : io.stderr,
        stderr: io.stderr,
      });
    } catch (error) {
      write(io.stderr, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    if (requestedFormat === 'json') {
      write(io.stdout, JSON.stringify(formats.json, null, 2));
      return;
    }
    if (requestedFormat === 'hermes') {
      write(io.stdout, formats.hermes);
      return;
    }

    write(io.stdout, `Goliath ${PACKAGE.version} setup complete.`);
    write(io.stdout, `Local data: ${dirname(directories[0])}`);
    write(io.stdout, '');
    write(io.stdout, 'Paste this into Claude, Codex, Cursor, or another JSON-based MCP client:');
    write(io.stdout, JSON.stringify(formats.json, null, 2));
    write(io.stdout, '');
    write(io.stdout, 'Hermes config.yaml:');
    write(io.stdout, formats.hermes);
    write(io.stdout, '');
    write(io.stdout, `Files an agent uploads must be placed in: ${config.uploadsDir}`);
    write(io.stdout, 'The MCP command starts and stops the local Goliath server automatically.');
    return;
  }

  write(io.stderr, `Unknown command: ${command}`);
  write(io.stderr, 'Run goliath --help for usage.');
  process.exitCode = 1;
}
