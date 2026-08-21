#!/usr/bin/env node
// Background server control: `npm run up`, `npm run down`, `npm run status`.
//
// Wraps lib/service.js with the shared terminal UI. Rendering lives here so the
// lifecycle logic stays free of I/O and can be tested directly.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import tui from '../lib/tui.js';
import { formatDuration } from '../lib/tui.js';
import { inspectInstall } from '../lib/browser-install.js';
import {
  logFilePath,
  resolvePort,
  start,
  status,
  stop,
  tailLog,
} from '../lib/service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function summary(state, { title = 'Running' } = {}) {
  tui.line();
  tui.box([
    `${tui.style.gray('URL    ')} ${tui.style.bold(`http://localhost:${state.port}`)}`,
    `${tui.style.gray('Docs   ')} http://localhost:${state.port}/docs`,
    `${tui.style.gray('PID    ')} ${state.pid}`,
    `${tui.style.gray('Logs   ')} ${logFilePath(ROOT)}`,
  ], { title });
  tui.line();
  tui.kv([
    ['npm run status', 'Check whether it is still up'],
    ['npm run logs', 'Follow the server log'],
    ['npm run down', 'Stop it'],
  ], { indent: '    ' });
  tui.line();
}

async function up(argv) {
  const port = resolvePort(process.env);

  const runtime = inspectInstall();
  if (!runtime.installed) {
    tui.fail('Browser runtime is not installed');
    tui.note('Run `npm run setup` first.');
    return 1;
  }

  const existing = await status(ROOT);
  if (existing.running) {
    tui.ok(`Already running on port ${existing.port} ${tui.style.gray(`(pid ${existing.pid})`)}`);
    summary(existing);
    return 0;
  }

  const spinner = tui.spinner(`Starting server on port ${port}…`);
  try {
    const state = await start(ROOT, { port, onAttempt: () => {} });
    spinner.succeed(`Server ready on port ${state.port} ${tui.style.gray(`(pid ${state.pid})`)}`);
    if (!process.env.GOLIATH_ACCESS_KEY) {
      tui.warn('GOLIATH_ACCESS_KEY is not set — do not expose this port beyond localhost.');
    }
    summary(state);
    return 0;
  } catch (err) {
    spinner.fail(err.message);
    if (err.logTail?.length) {
      tui.line();
      tui.line(`  ${tui.style.gray('Last lines of the server log:')}`);
      for (const entry of err.logTail.slice(-12)) tui.line(`    ${tui.style.gray(entry.slice(0, 160))}`);
    }
    tui.line();
    tui.note(`Full log: ${logFilePath(ROOT)}`);
    return 1;
  }
}

async function down() {
  const spinner = tui.spinner('Stopping server…');
  const result = await stop(ROOT);
  if (!result.stopped) {
    spinner.warn(result.stale ? 'Not running (cleared a stale PID file)' : 'Not running');
    return 0;
  }
  spinner.succeed(`Stopped ${tui.style.gray(`(pid ${result.pid}${result.forced ? ', forced' : ''})`)}`);
  return 0;
}

async function report() {
  const state = await status(ROOT);
  if (!state.running) {
    tui.info(state.stale ? 'Not running (cleared a stale PID file)' : 'Not running');
    tui.note('Start it with `npm run up`.');
    return 1;
  }
  tui.ok(`Running ${tui.style.gray(`for ${formatDuration(state.uptimeMs)}`)}`);
  summary(state);
  return 0;
}

async function logs(argv) {
  const follow = argv.includes('-f') || argv.includes('--follow');
  if (!follow) {
    for (const entry of tailLog(ROOT, 60)) tui.line(entry);
    return 0;
  }

  // Delegated to `tail -f` rather than reimplemented: it already handles
  // truncation and rotation, and this command is inherently interactive.
  const { spawn: launch } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = launch('tail', ['-f', logFilePath(ROOT)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function restart(argv) {
  await down();
  return up(argv);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'up': return up(rest);
    case 'down': return down();
    case 'status': return report();
    case 'logs': return logs(rest);
    case 'restart': return restart(rest);
    default:
      tui.fail(`Unknown command: ${command ?? '(none)'}`);
      tui.note('Expected one of: up, down, status, restart, logs');
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
