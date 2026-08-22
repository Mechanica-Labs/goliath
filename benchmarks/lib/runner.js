import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { summarizeNumbers } from './stats.js';

/**
 * Execute a benchmark suite and return a stable, machine-readable report.
 *
 * Each measured sample receives a fresh Goliath user/session identity. This
 * avoids cross-case browser state and makes a failed sample safe to continue
 * after cleanup. Warmups are excluded from latency/success-rate statistics,
 * but a warmup failure still fails the case because instability is a correctness signal.
 */
export async function runSuite({
  suite,
  createClient,
  fixtureBaseUrl,
  runs = 3,
  warmup = 1,
  filter = null,
  onSample = () => {},
}) {
  validatePositiveInteger(runs, 'runs');
  validateNonNegativeInteger(warmup, 'warmup');

  const selectedCases = filter
    ? suite.cases.filter(testCase => testCase.id.includes(filter))
    : suite.cases;

  if (selectedCases.length === 0) {
    throw new Error(`No benchmark cases matched${filter ? ` filter "${filter}"` : ''}`);
  }

  const startedAt = new Date().toISOString();
  const caseReports = [];

  for (const testCase of selectedCases) {
    const warmupSamples = [];
    for (let index = 0; index < warmup; index += 1) {
      warmupSamples.push(await executeSample({
        testCase,
        createClient,
        fixtureBaseUrl,
        measured: false,
      }));
    }

    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const sample = await executeSample({ testCase, createClient, fixtureBaseUrl, measured: true });
      samples.push(sample);
      onSample({ testCase, sample, index, runs });
    }

    caseReports.push(summarizeCase(testCase, samples, warmupSamples));
  }

  const allSamples = caseReports.flatMap(report => report.samples);
  const passedSamples = allSamples.filter(sample => sample.pass).length;
  const failedSamples = allSamples.length - passedSamples;
  const passingCases = caseReports.filter(report => report.pass).length;

  return {
    schemaVersion: 1,
    benchmark: suite.id,
    suiteVersion: suite.version || 1,
    title: suite.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      runs,
      warmup,
      filter,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    summary: {
      pass: passingCases === caseReports.length,
      cases: caseReports.length,
      passingCases,
      failingCases: caseReports.length - passingCases,
      samples: allSamples.length,
      passedSamples,
      failedSamples,
      successRate: ratio(passedSamples, allSamples.length),
      latencyMs: summarizeNumbers(allSamples.map(sample => sample.latencyMs)),
      apiCalls: summarizeNumbers(allSamples.map(sample => sample.apiCalls)),
    },
    cases: caseReports,
  };
}

async function executeSample({ testCase, createClient, fixtureBaseUrl, measured }) {
  const runId = randomUUID().slice(0, 8);
  const client = createClient({
    userId: `benchmark-${testCase.id}-${runId}`,
    sessionKey: `benchmark-${testCase.id}`,
  });

  const requestStart = client.requestCount || 0;
  const started = performance.now();
  let pass = false;
  let error = null;
  let details = null;

  try {
    details = await testCase.run({
      client,
      fixtureUrl(pathname) {
        return new URL(pathname, fixtureBaseUrl).toString();
      },
    });
    pass = true;
  } catch (caught) {
    error = serializeError(caught);
  } finally {
    try {
      await client.deleteSession();
    } catch (cleanupError) {
      if (!error) {
        pass = false;
        error = serializeError(new Error(`benchmark passed but cleanup failed: ${cleanupError.message}`));
      }
    }
  }

  const latencyMs = Number((performance.now() - started).toFixed(2));
  const apiCalls = Math.max(0, (client.requestCount || 0) - requestStart - 1); // exclude cleanup

  return {
    pass,
    measured,
    latencyMs,
    apiCalls,
    ...(details === undefined || details === null ? {} : { details }),
    ...(error ? { error } : {}),
  };
}

function summarizeCase(testCase, samples, warmupSamples = []) {
  const passed = samples.filter(sample => sample.pass).length;
  const failures = samples.filter(sample => !sample.pass).map(sample => sample.error);
  const warmupFailures = warmupSamples.filter(sample => !sample.pass).map(sample => sample.error);

  return {
    id: testCase.id,
    title: testCase.title,
    description: testCase.description,
    pass: passed === samples.length && warmupFailures.length === 0,
    runs: samples.length,
    passed,
    failed: samples.length - passed,
    successRate: ratio(passed, samples.length),
    warmup: {
      runs: warmupSamples.length,
      failed: warmupFailures.length,
      ...(warmupFailures.length ? { failures: warmupFailures } : {}),
    },
    latencyMs: summarizeNumbers(samples.map(sample => sample.latencyMs)),
    apiCalls: summarizeNumbers(samples.map(sample => sample.apiCalls)),
    ...(failures.length ? { failures } : {}),
    samples,
  };
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer >= 1`);
}

function validateNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be an integer >= 0`);
}
