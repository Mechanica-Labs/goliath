import { test, expect, jest } from '@jest/globals';
import { createReporter } from '../../lib/reporter.js';

test('disabled reporter preserves the complete lifecycle interface', async () => {
  const reporter = createReporter({ crashReportEnabled: false });
  expect(() => reporter.startWatchdog(1000, () => ({}))).not.toThrow();
  expect(() => reporter.trackRoute('GET /health')).not.toThrow();
  expect(() => reporter.resetNativeMemBaseline()).not.toThrow();
  await expect(reporter.reportCrash(new Error('ignored'))).resolves.toBeUndefined();
  await expect(reporter.reportHang('test', 1)).resolves.toBeUndefined();
  await expect(reporter.reportStuckLoop({})).resolves.toBeUndefined();
  expect(() => reporter.stop()).not.toThrow();
});

test('telemetry is disabled by default without an explicit flag', async () => {
  const reporter = createReporter({});
  expect(() => reporter.startWatchdog(1000, () => ({}))).not.toThrow();
  await expect(reporter.reportCrash(new Error('should not send'))).resolves.toBeUndefined();
  await expect(reporter.reportHang('test', 1)).resolves.toBeUndefined();
  expect(reporter.stop()).toBeUndefined();
});

test('telemetry requires both explicit opt-in and an HTTPS relay', async () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  global.fetch = fetchMock;

  try {
    const missingUrl = createReporter({ crashReportEnabled: true });
    await missingUrl.reportCrash(new Error('ignored'));
    await missingUrl.stop();

    const insecureUrl = createReporter({
      crashReportEnabled: true,
      crashReportUrl: 'http://telemetry.example.test/report',
    });
    await insecureUrl.reportCrash(new Error('ignored'));
    await insecureUrl.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    global.fetch = originalFetch;
  }
});

test('telemetry sends only to an explicitly configured HTTPS relay', async () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock;

  try {
    const reporter = createReporter({
      crashReportEnabled: true,
      crashReportUrl: 'https://telemetry.example.test/report',
    });
    await reporter.reportCrash(new Error('test failure'));
    await reporter.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://telemetry.example.test/report');
  } finally {
    global.fetch = originalFetch;
  }
});
