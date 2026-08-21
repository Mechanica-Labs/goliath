import { test, expect } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

test('Goliath executable setting takes precedence over Camoufox aliases', () => {
  const before = { ...process.env };
  try {
    process.env.GOLIATH_EXECUTABLE = '/tmp/goliath';
    process.env.CAMOUFOX_EXECUTABLE = '/tmp/camoufox';
    expect(loadConfig().goliathExecutablePath).toBe('/tmp/goliath');
  } finally {
    process.env = before;
  }
});

test('Camoufox executable aliases remain compatible', () => {
  const before = { ...process.env };
  try {
    delete process.env.GOLIATH_EXECUTABLE;
    delete process.env.GOLIATH_EXECUTABLE_PATH;
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/tmp/camoufox';
    expect(loadConfig().goliathExecutablePath).toBe('/tmp/camoufox');
    expect(loadConfig().goliathCacheDir).toContain('camoufox');
  } finally {
    process.env = before;
  }
});

test('legacy Camoufox service variables remain deploy-compatible', () => {
  const before = { ...process.env };
  try {
    delete process.env.GOLIATH_PORT;
    delete process.env.GOLIATH_API_KEY;
    process.env.CAMOFOX_PORT = '19477';
    process.env.CAMOFOX_API_KEY = 'legacy-key';
    const config = loadConfig();
    expect(config.port).toBe(19477);
    expect(config.apiKey).toBe('legacy-key');
  } finally {
    process.env = before;
  }
});

test('crash reporting is disabled without explicit opt-in and relay URL', () => {
  const before = { ...process.env };
  try {
    delete process.env.GOLIATH_CRASH_REPORT_ENABLED;
    delete process.env.GOLIATH_CRASH_REPORT_URL;
    delete process.env.CAMOFOX_CRASH_REPORT_ENABLED;
    delete process.env.CAMOFOX_CRASH_REPORT_URL;

    const config = loadConfig();
    expect(config.crashReportEnabled).toBe(false);
    expect(config.crashReportUrl).toBe('');
  } finally {
    process.env = before;
  }
});

test('crash-report settings are forwarded to the server subprocess', () => {
  const before = { ...process.env };
  try {
    process.env.GOLIATH_CRASH_REPORT_ENABLED = 'true';
    process.env.GOLIATH_CRASH_REPORT_URL = 'https://telemetry.example.test/report';

    const config = loadConfig();
    expect(config.crashReportEnabled).toBe(true);
    expect(config.crashReportUrl).toBe('https://telemetry.example.test/report');
    expect(config.serverEnv.GOLIATH_CRASH_REPORT_ENABLED).toBe('true');
    expect(config.serverEnv.GOLIATH_CRASH_REPORT_URL).toBe('https://telemetry.example.test/report');
  } finally {
    process.env = before;
  }
});

test('screenshot directory can be overridden', () => {
  const before = { ...process.env };
  try {
    process.env.GOLIATH_SCREENSHOTS_DIR = '/tmp/goliath-shots';
    expect(loadConfig().screenshotsDir).toBe('/tmp/goliath-shots');
  } finally {
    process.env = before;
  }
});
