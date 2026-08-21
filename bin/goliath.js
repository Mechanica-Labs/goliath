#!/usr/bin/env node
import { runCli } from '../lib/cli.js';

const args = process.argv.slice(2);
const lifecycleCommands = new Set(['up', 'down', 'restart', 'status', 'logs']);

if (lifecycleCommands.has(args[0])) {
  const { main } = await import('../scripts/service.js');
  process.exitCode = await main(args);
} else {
  await runCli(args);
}
