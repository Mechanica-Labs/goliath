import { test, expect } from '@jest/globals';
import { runSuite } from '../../benchmarks/lib/runner.js';
import { percentile, summarizeNumbers } from '../../benchmarks/lib/stats.js';

test('benchmark statistics are deterministic for small samples', () => {
  expect(percentile([40, 10, 30, 20], 0.50)).toBe(20);
  expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
  expect(summarizeNumbers([10, 20, 30, 40])).toEqual({
    min: 10,
    p50: 20,
    p95: 40,
    max: 40,
    mean: 25,
  });
});

test('runner isolates samples, excludes warmups, and records API calls', async () => {
  let sequence = 0;
  const deletedUsers = [];
  const suite = {
    id: 'unit',
    title: 'Unit suite',
    cases: [{
      id: 'happy-path',
      title: 'Happy path',
      description: 'A fake benchmark case.',
      async run({ client }) {
        await client.fakeRequest();
        return { sequence: ++sequence };
      },
    }],
  };

  const report = await runSuite({
    suite,
    fixtureBaseUrl: 'http://127.0.0.1:1',
    runs: 2,
    warmup: 1,
    createClient({ userId }) {
      return {
        userId,
        requestCount: 0,
        async fakeRequest() { this.requestCount += 1; },
        async deleteSession() {
          this.requestCount += 1;
          deletedUsers.push(this.userId);
        },
      };
    },
  });

  expect(sequence).toBe(3);
  expect(deletedUsers).toHaveLength(3);
  expect(new Set(deletedUsers).size).toBe(3);
  expect(report.summary.samples).toBe(2);
  expect(report.summary.pass).toBe(true);
  expect(report.cases[0].samples).toHaveLength(2);
  expect(report.cases[0].samples.map(sample => sample.apiCalls)).toEqual([1, 1]);
});

test('runner converts a failed assertion into report data and still cleans up', async () => {
  let cleaned = false;
  const suite = {
    id: 'unit-failure',
    title: 'Failure suite',
    cases: [{
      id: 'fails',
      title: 'Fails',
      description: 'Intentional failure.',
      async run() {
        throw new Error('fixture assertion failed');
      },
    }],
  };

  const report = await runSuite({
    suite,
    fixtureBaseUrl: 'http://127.0.0.1:1',
    runs: 1,
    warmup: 0,
    createClient() {
      return {
        requestCount: 0,
        async deleteSession() {
          this.requestCount += 1;
          cleaned = true;
        },
      };
    },
  });

  expect(cleaned).toBe(true);
  expect(report.summary.pass).toBe(false);
  expect(report.summary.failedSamples).toBe(1);
  expect(report.cases[0].failures[0].message).toBe('fixture assertion failed');
});
