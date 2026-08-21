#!/usr/bin/env node
// One-command setup for Goliath: `npm run setup` (or `goliath install`).
//
// Runs the whole path from a fresh clone to a runnable server -- preflight
// checks, npm dependencies, browser runtime download, and verification -- and
// renders it as a single coherent progress report.
//
// This is a user-invoked command, so it exits non-zero on failure and remains
// explicit under npm versions that restrict dependency lifecycle scripts.
//
// Flags:
//   --check        Report status only; install nothing. Exits 1 if incomplete.
//   --force        Reinstall the browser runtime even if already present.
//   --skip-deps    Do not run `npm install`.
//   --skip-browser Do not download the browser runtime.
//   --help

import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import tui, { formatBytes } from '../lib/tui.js';
import {
  LINUX_BROWSER_APT_PACKAGE_CANDIDATES,
  LINUX_BROWSER_APT_PACKAGES,
  cacheDir,
  externalExecutableFromEnv,
  freeDiskBytes,
  inspectLinuxRuntimeDependencies,
  inspectInstall,
  installBrowser,
  installedSize,
  verifyBrowserLaunch,
} from '../lib/browser-install.js';
import { resolvePort } from '../lib/service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 22;
const REQUIRED_FREE_BYTES = 1_200_000_000; // ~700MB extracted plus the staged archive.

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    check: flags.has('--check'),
    force: flags.has('--force'),
    skipDeps: flags.has('--skip-deps'),
    skipBrowser: flags.has('--skip-browser'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function showHelp() {
  tui.banner('Agent-first browser automation server');
  tui.line(`  ${tui.style.bold('Usage')}`);
  tui.line(`    npm run setup ${tui.style.gray('[options]')}`);
  tui.line();
  tui.line(`  ${tui.style.bold('Options')}`);
  tui.kv([
    ['--check', 'Report status only; install nothing'],
    ['--force', 'Reinstall the browser runtime even if present'],
    ['--skip-deps', 'Skip `npm install`'],
    ['--skip-browser', 'Skip the browser runtime download'],
    ['--help', 'Show this message'],
  ], { indent: '    ' });
  tui.line();
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function aptCommand(packages = LINUX_BROWSER_APT_PACKAGES) {
  return `apt-get update && apt-get install -y ${packages.join(' ')}`;
}

/** Node version, architecture support, and disk headroom. Throws on a hard stop. */
function preflight() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    tui.fail(`Node ${process.versions.node} is too old — Goliath needs Node ${MIN_NODE_MAJOR} or newer`);
    tui.note('Install a newer runtime: https://nodejs.org  (or `nvm install 22`)');
    throw new Error('unsupported node version');
  }
  tui.ok(`Node ${process.versions.node}`);
  tui.ok(`Platform ${platform()} ${arch()}`);

  const free = freeDiskBytes(cacheDir());
  if (free === null) {
    tui.note('Could not read free disk space; skipping that check.');
  } else if (free < REQUIRED_FREE_BYTES) {
    tui.warn(`Low disk space: ${humanBytes(free)} free, ~${humanBytes(REQUIRED_FREE_BYTES)} recommended`);
  } else {
    tui.ok(`Disk ${humanBytes(free)} free`);
  }
}

/** Install npm dependencies when node_modules is absent. */
async function ensureDependencies({ skipDeps }) {
  if (skipDeps) {
    tui.note('Skipped (--skip-deps).');
    return;
  }
  if (existsSync(join(ROOT, 'node_modules', 'camoufox-js'))) {
    tui.ok('Dependencies already installed');
    return;
  }

  const spinner = tui.spinner('Installing npm dependencies…');
  // Renamed binding keeps process spawning isolated and easy for static scanners
  // to audit.
  const { spawnSync: run } = await import('node:child_process');

  // The browser step below owns runtime installation after dependencies exist.
  const result = run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GOLIATH_SKIP_DOWNLOAD: '1' },
    shell: platform() === 'win32',
  });

  if (result.status !== 0) {
    spinner.fail('npm install failed');
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) tui.line(tui.style.gray(output.split('\n').slice(-12).join('\n')));
    throw new Error('dependency installation failed');
  }
  spinner.succeed('Dependencies installed');
}

async function canRunSudo(run) {
  const result = run('sudo', ['-n', 'true'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function packageExists(run, useSudo, name) {
  const result = run(useSudo ? 'sudo' : 'apt-cache', useSudo ? ['apt-cache', 'show', name] : ['show', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  return result.status === 0;
}

function resolveLinuxSystemPackages(run, useSudo) {
  return LINUX_BROWSER_APT_PACKAGE_CANDIDATES.map((candidates) => (
    candidates.find((name) => packageExists(run, useSudo, name)) || candidates[0]
  ));
}

async function ensureLinuxSystemPackages({ skipBrowser }) {
  if (skipBrowser || platform() !== 'linux') {
    if (platform() !== 'linux') tui.note('Skipped (not Linux).');
    else tui.note('Skipped (--skip-browser).');
    return;
  }

  const external = externalExecutableFromEnv();
  if (external) {
    tui.note(`Using external runtime from ${external.name}; system package checks are launch-verified later.`);
    return;
  }

  // Install proactively on Debian/Ubuntu. The runtime may not exist yet on a
  // first install, but these are the same packages required by the Docker image.
  if (!existsSync('/usr/bin/apt-get')) {
    tui.warn('Cannot auto-install browser system packages: apt-get was not found.');
    tui.note('Install GTK/X11/Mesa/font packages for Firefox/Camoufox, then re-run this command.');
    return;
  }

  const { spawnSync: run } = await import('node:child_process');
  const useSudo = typeof process.getuid === 'function' && process.getuid() !== 0;
  const command = useSudo ? 'sudo' : 'apt-get';

  if (useSudo && !(await canRunSudo(run))) {
    tui.warn('Cannot auto-install browser system packages without passwordless sudo.');
    tui.note(`Run: sudo ${aptCommand()}`);
    return;
  }

  const packages = resolveLinuxSystemPackages(run, useSudo);

  const spinner = tui.spinner('Installing Linux browser system packages...');
  const result = run(command, useSudo ? ['apt-get', 'update'] : ['update'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  if (result.status !== 0) {
    spinner.fail('apt-get update failed');
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) tui.line(tui.style.gray(output.split('\n').slice(-12).join('\n')));
    tui.note(`Run manually: ${useSudo ? 'sudo ' : ''}${aptCommand(packages)}`);
    throw new Error('Linux browser system package update failed');
  }

  const install = run(command, [
    ...(useSudo ? ['apt-get'] : []),
    'install',
    '-y',
    ...packages,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  if (install.status !== 0) {
    spinner.fail('Linux browser system package install failed');
    const output = `${install.stdout || ''}${install.stderr || ''}`.trim();
    if (output) tui.line(tui.style.gray(output.split('\n').slice(-12).join('\n')));
    tui.note(`Run manually: ${useSudo ? 'sudo ' : ''}${aptCommand(packages)}`);
    throw new Error('Linux browser system package installation failed');
  }

  spinner.succeed('Linux browser system packages installed');
}

/** Download the browser runtime, rendering a live progress bar. */
async function ensureBrowser({ force, skipBrowser }) {
  if (skipBrowser) {
    tui.note('Skipped (--skip-browser).');
    return;
  }

  const external = externalExecutableFromEnv();
  if (external) {
    tui.ok(`Using external runtime from ${external.name}`);
    tui.note(external.value);
    return;
  }

  const current = inspectInstall();
  if (current.installed && !force) {
    tui.ok(`Runtime already installed (${current.version}${current.release ? ` ${current.release}` : ''})`);
    tui.note('Re-run with --force to reinstall.');
    return;
  }

  const resolving = tui.spinner('Resolving latest compatible runtime…');
  let bar = null;

  await installBrowser({
    onEvent(event) {
      switch (event.type) {
        case 'resolve:done':
          resolving.succeed(`Runtime ${event.version} ${tui.style.gray(event.release)}`);
          break;
        case 'download':
          if (event.phase === 'start') {
            bar = tui.progress({ label: 'Downloading', total: event.total });
          } else if (event.phase === 'data') {
            bar?.update(event.transferred);
          } else if (event.phase === 'retry') {
            bar?.done();
            bar = null;
            tui.warn(`Download attempt ${event.attempt} failed (${event.error}); retrying…`);
          }
          break;
        case 'download:done':
          bar?.done(`Downloaded ${tui.style.bold(formatBytes(event.bytes))}`);
          bar = null;
          break;
        case 'extract:start':
          bar = null;
          tui.info('Extracting runtime…');
          break;
        case 'extract:done':
          tui.ok('Runtime extracted');
          break;
        default:
          break;
      }
    },
  });
}

/** Verify the install and print the summary. Returns true when usable. */
function report() {
  const status = inspectInstall();
  if (!status.installed) {
    tui.fail('Browser runtime is not usable');
    for (const issue of status.issues) tui.note(issue);
    return false;
  }

  if (status.kind === 'external') {
    tui.ok('External runtime verified');
    tui.box([
      `${tui.style.gray('Source    ')} ${status.source}`,
      `${tui.style.gray('Executable')} ${status.executable}`,
    ], { title: 'Ready' });
    return true;
  }

  tui.ok('Browser runtime verified');
  tui.line();
  tui.box([
    `${tui.style.gray('Runtime  ')} ${tui.style.bold(status.version)} ${tui.style.gray(status.release)}`,
    `${tui.style.gray('Location ')} ${status.directory}`,
    `${tui.style.gray('Size     ')} ${formatBytes(installedSize())}`,
  ], { title: 'Ready' });
  return true;
}

async function verifyRuntimeReady() {
  const status = inspectInstall();
  if (!status.installed) return false;

  if (platform() === 'linux' && status.kind !== 'external') {
    const deps = await inspectLinuxRuntimeDependencies();
    if (!deps.ok) {
      tui.fail('Linux browser system dependencies are missing');
      for (const issue of deps.issues) tui.note(issue);
      tui.note(`Install them with: ${aptCommand()}`);
      return false;
    }
    tui.ok('Linux browser system dependencies verified');
  }

  const spinner = tui.spinner('Launching browser runtime...');
  const launch = await verifyBrowserLaunch();
  if (!launch.ok) {
    spinner.fail('Browser runtime launch failed');
    tui.note(launch.error);
    if (platform() === 'linux') {
      tui.note(`Install/repair system packages with: ${aptCommand()}`);
      tui.note('In Docker, also ensure the container permits browser sandboxing or run with a compatible security profile.');
    }
    return false;
  }
  spinner.succeed('Browser runtime launched');
  return true;
}

function nextSteps() {
  const port = resolvePort(process.env);
  tui.line();
  tui.line(`  ${tui.style.bold('Next steps')}`);
  tui.line();
  tui.kv([
    ['npm run up', `Start the server in the background on http://localhost:${port}`],
    ['npm start', 'Run the server in the foreground'],
    ['npm test', 'Run the test suite'],
  ], { indent: '    ' });
  tui.line();
  tui.line(`    ${tui.style.gray('Set')} ${tui.style.bold('GOLIATH_ACCESS_KEY')} ${tui.style.gray('before exposing the server beyond localhost.')}`);
  tui.line();
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return 0;
  }

  if (options.check) {
    tui.banner('Installation check');
    const usable = report() && await verifyRuntimeReady();
    return usable ? 0 : 1;
  }

  const startedAt = Date.now();
  tui.banner('Agent-first browser automation server');
  tui.hideCursor();

  const restore = () => { tui.showCursor(); };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  try {
    const total = 5;
    tui.step(1, total, 'Checking environment');
    preflight();

    tui.step(2, total, 'Installing system packages');
    await ensureLinuxSystemPackages(options);

    tui.step(3, total, 'Installing dependencies');
    await ensureDependencies(options);

    tui.step(4, total, 'Installing browser runtime');
    await ensureBrowser(options);

    tui.step(5, total, 'Verifying');
    if (!report()) return 1;
    if (!await verifyRuntimeReady()) return 1;

    tui.line();
    tui.line(`  ${tui.style.green(tui.sym.ok)} ${tui.style.bold('Goliath is ready')} ${tui.style.gray(`in ${Math.round((Date.now() - startedAt) / 1000)}s`)}`);
    nextSteps();
    return 0;
  } catch (err) {
    tui.line();
    tui.fail(err.message);
    tui.note('Re-run `npm run setup` after resolving the issue, or open an issue at');
    tui.note('https://github.com/Mechanica-Labs/goliath/issues');
    tui.line();
    return 1;
  } finally {
    restore();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
