#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoliathBenchmarkClient } from '../benchmarks/lib/api-client.js';
import { startFixtureServer } from '../benchmarks/lib/fixture-server.js';
import { runSuite } from '../benchmarks/lib/runner.js';
import { coreSuite } from '../benchmarks/suites/core.js';

const SUITES = new Map([[coreSuite.id, coreSuite]]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const suite = SUITES.get(options.suite);
  if (!suite) {
    throw new Error(`Unknown suite "${options.suite}". Available: ${[...SUITES.keys()].join(', ')}`);
  }

  if (options.list) {
    for (const testCase of suite.cases) {
      process.stdout.write(`${testCase.id.padEnd(18)} ${testCase.title}\n`);
    }
    return;
  }

  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const token = process.env.GOLIATH_BENCHMARK_TOKEN || process.env.GOLIATH_ACCESS_KEY || process.env.GOLIATH_API_KEY || null;
  const probe = new GoliathBenchmarkClient({
    baseUrl,
    userId: 'benchmark-health-probe',
    sessionKey: 'benchmark-health-probe',
    timeoutMs: options.timeoutMs,
    token,
  });

  try {
    await probe.health();
  } catch (error) {
    throw new Error(`Goliath is not reachable at ${baseUrl}: ${error.message}`);
  }

  const fixture = await startFixtureServer();
  try {
    if (!options.json) {
      process.stdout.write(`\nGoliath benchmark\n`);
      process.stdout.write(`  suite:    ${suite.id}\n`);
      process.stdout.write(`  server:   ${baseUrl}\n`);
      process.stdout.write(`  fixtures: ${fixture.baseUrl}\n`);
      process.stdout.write(`  runs:     ${options.runs} measured + ${options.warmup} warmup\n\n`);
    }

    const report = await runSuite({
      suite,
      fixtureBaseUrl: fixture.baseUrl,
      runs: options.runs,
      warmup: options.warmup,
      filter: options.filter,
      createClient({ userId, sessionKey }) {
        return new GoliathBenchmarkClient({
          baseUrl,
          userId,
          sessionKey,
          timeoutMs: options.timeoutMs,
          token,
        });
      },
      onSample: options.json ? undefined : ({ testCase, sample, index, runs }) => {
        const status = sample.pass ? 'PASS' : 'FAIL';
        const suffix = sample.pass ? '' : `  ${sample.error?.message || 'unknown error'}`;
        process.stdout.write(
          `${status.padEnd(4)}  ${testCase.id.padEnd(18)} ` +
          `run ${String(index + 1).padStart(String(runs).length)}/${runs}  ` +
          `${String(sample.latencyMs.toFixed(0)).padStart(5)} ms  ` +
          `${String(sample.apiCalls).padStart(2)} calls${suffix}\n`,
        );
      },
    });

    report.target = { baseUrl: sanitizeUrl(baseUrl) };

    if (options.output) {
      const outputPath = path.resolve(options.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      if (!options.json) process.stdout.write(`\nReport written to ${outputPath}\n`);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printSummary(report);
    }

    process.exitCode = report.summary.pass ? 0 : 1;
  } finally {
    await fixture.close();
  }
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function printSummary(report) {
  const { summary } = report;
  process.stdout.write('\nSummary\n');
  process.stdout.write(`  cases:        ${summary.passingCases}/${summary.cases} passed\n`);
  process.stdout.write(`  samples:      ${summary.passedSamples}/${summary.samples} passed\n`);
  process.stdout.write(`  success rate: ${(summary.successRate * 100).toFixed(1)}%\n`);
  process.stdout.write(
    `  latency:      p50 ${summary.latencyMs.p50.toFixed(0)} ms, ` +
    `p95 ${summary.latencyMs.p95.toFixed(0)} ms, max ${summary.latencyMs.max.toFixed(0)} ms\n`,
  );
  process.stdout.write(`  result:       ${summary.pass ? 'PASS' : 'FAIL'}\n`);
}

function parseArgs(args) {
  const options = {
    baseUrl: process.env.GOLIATH_BASE || 'http://127.0.0.1:9377',
    suite: 'core',
    runs: 3,
    warmup: 1,
    timeoutMs: 45_000,
    filter: null,
    output: null,
    json: false,
    list: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--base') options.baseUrl = requiredValue(args, ++index, arg);
    else if (arg === '--suite') options.suite = requiredValue(args, ++index, arg);
    else if (arg === '--filter') options.filter = requiredValue(args, ++index, arg);
    else if (arg === '--output') options.output = requiredValue(args, ++index, arg);
    else if (arg === '--runs') options.runs = integerValue(requiredValue(args, ++index, arg), arg, 1);
    else if (arg === '--warmup') options.warmup = integerValue(requiredValue(args, ++index, arg), arg, 0);
    else if (arg === '--timeout') options.timeoutMs = integerValue(requiredValue(args, ++index, arg), arg, 1);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function integerValue(value, flag, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Goliath reproducible browser benchmark\n\n`);
  process.stdout.write(`Usage:\n  npm run benchmark -- [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --base <url>       Goliath REST base URL (default: GOLIATH_BASE or http://127.0.0.1:9377)\n`);
  process.stdout.write(`  --suite <name>     Benchmark suite (default: core)\n`);
  process.stdout.write(`  --filter <text>    Run cases whose id contains text\n`);
  process.stdout.write(`  --runs <n>         Measured samples per case (default: 3)\n`);
  process.stdout.write(`  --warmup <n>       Unmeasured warmups per case (default: 1)\n`);
  process.stdout.write(`  --timeout <ms>     Per-request timeout (default: 45000, above Goliath's 30s handler budget)\n`);
  process.stdout.write(`  --output <path>    Write the JSON report to a file\n`);
  process.stdout.write(`  --json             Emit only the JSON report to stdout\n`);
  process.stdout.write(`  --list             List cases without running them\n`);
  process.stdout.write(`  -h, --help         Show this help\n\n`);
  process.stdout.write(`Examples:\n`);
  process.stdout.write(`  npm run benchmark\n`);
  process.stdout.write(`  npm run benchmark -- --runs 5 --output .goliath/benchmarks/core.json\n`);
  process.stdout.write(`  npm run benchmark -- --filter snapshot --json\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
