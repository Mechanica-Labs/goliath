/**
 * Centralized environment configuration for goliath.
 *
 * All process.env access is centralized here for auditability.
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

/**
 * Parse PROXY_PORTS env var into an array of port numbers.
 * Supports range ("10001-10010") or comma-separated ("10001,10002,10003").
 * Falls back to single PROXY_PORT if PROXY_PORTS is not set.
 */
function parseProxyPorts(portsEnv, singlePort) {
  if (portsEnv) {
    if (portsEnv.includes('-')) {
      const [start, end] = portsEnv.split('-').map(s => parseInt(s.trim(), 10));
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
    }
    const parsed = portsEnv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (parsed.length > 0) return parsed;
  }
  if (singlePort) {
    const p = parseInt(singlePort, 10);
    if (!isNaN(p)) return [p];
  }
  return [];
}

function inferProxyStrategy(explicitStrategy) {
  if (explicitStrategy) return explicitStrategy;
  return 'round_robin';
}

function camoufoxCacheDir(env = process.env) {
  if (env.CAMOUFOX_INSTALL_DIR) return resolve(env.CAMOUFOX_INSTALL_DIR);
  const home = os.homedir();
  // Goliath is powered by camoufox-js, which owns the on-disk browser cache.
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

function camoufoxExecutablePath(env = process.env) {
  return (
    env.GOLIATH_EXECUTABLE ||
    env.GOLIATH_EXECUTABLE_PATH ||
    env.CAMOUFOX_EXECUTABLE ||
    env.CAMOUFOX_EXECUTABLE_PATH ||
    env.CAMOFOX_EXECUTABLE_PATH ||
    ''
  ).trim();
}

function loadConfig() {
  const externalCamoufoxExecutable = camoufoxExecutablePath();
  const mcpAutoStartValue = (process.env.GOLIATH_MCP_AUTO_START || 'true').trim().toLowerCase();
  return {
    port: parseInt(process.env.GOLIATH_PORT || process.env.CAMOFOX_PORT || process.env.PORT || '9377', 10),
    bindHost: (process.env.GOLIATH_BIND_HOST || process.env.CAMOFOX_BIND_HOST || '127.0.0.1').trim(),
    nodeEnv: process.env.NODE_ENV || 'development',
    flyMachineId: process.env.FLY_MACHINE_ID || '',
    flyAppName: process.env.FLY_APP_NAME || '',
    flyApiToken: process.env.FLY_API_TOKEN || '',
    adminKey: process.env.GOLIATH_ADMIN_KEY || process.env.CAMOFOX_ADMIN_KEY || '',
    apiKey: process.env.GOLIATH_API_KEY || process.env.CAMOFOX_API_KEY || '',
    accessKey: (process.env.GOLIATH_ACCESS_KEY || process.env.CAMOFOX_ACCESS_KEY || '').trim(),
    mcpBaseUrl: (process.env.GOLIATH_BASE_URL || '').trim(),
    mcpUserId: (process.env.GOLIATH_USER_ID || 'mcp-default').trim(),
    mcpSessionKey: (process.env.GOLIATH_SESSION_KEY || 'default').trim(),
    mcpAutoStart: !['0', 'false', 'no'].includes(mcpAutoStartValue),
    mcpStartupTimeoutMs: parseInt(process.env.GOLIATH_MCP_STARTUP_TIMEOUT_MS || '20000', 10),
    cookiesDir: process.env.GOLIATH_COOKIES_DIR || process.env.CAMOFOX_COOKIES_DIR || join(os.homedir(), '.goliath', 'cookies'),
    uploadsDir: process.env.GOLIATH_UPLOADS_DIR || process.env.CAMOFOX_UPLOADS_DIR || join(os.homedir(), '.goliath', 'uploads'),
    profileDir: process.env.GOLIATH_PROFILE_DIR || process.env.CAMOFOX_PROFILE_DIR || join(os.homedir(), '.goliath', 'profiles'),
    tracesDir: process.env.GOLIATH_TRACES_DIR || process.env.CAMOFOX_TRACES_DIR || join(os.homedir(), '.goliath', 'traces'),
    screenshotsDir: process.env.GOLIATH_SCREENSHOTS_DIR || join(os.homedir(), '.goliath', 'screenshots'),
    checkpointsDir: process.env.NODE_ENV === 'test'
      ? join(os.tmpdir(), `goliath-test-checkpoints-${process.pid}`)
      : join(os.homedir(), '.goliath', 'checkpoints'),
    tracesMaxBytes: parseInt(process.env.GOLIATH_TRACES_MAX_BYTES || process.env.CAMOFOX_TRACES_MAX_BYTES || String(50 * 1024 * 1024), 10),
    tracesTtlHours: parseInt(process.env.GOLIATH_TRACES_TTL_HOURS || process.env.CAMOFOX_TRACES_TTL_HOURS || '24', 10),
    handlerTimeoutMs: parseInt(process.env.HANDLER_TIMEOUT_MS) || 30000,
    maxConcurrentPerUser: parseInt(process.env.MAX_CONCURRENT_PER_USER) || 3,
    sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS) || 600000,
    tabInactivityMs: parseInt(process.env.TAB_INACTIVITY_MS) || 300000,
    maxSessions: parseInt(process.env.MAX_SESSIONS) || 50,
    maxTabsPerSession: parseInt(process.env.MAX_TABS_PER_SESSION) || 10,
    maxTabsGlobal: parseInt(process.env.MAX_TABS_GLOBAL) || 50,
    navigateTimeoutMs: parseInt(process.env.NAVIGATE_TIMEOUT_MS) || 25000,
    buildrefsTimeoutMs: parseInt(process.env.BUILDREFS_TIMEOUT_MS) || 12000,
    browserIdleTimeoutMs: parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS) || 300000,
    nativeMemRestartThresholdMb: parseInt(process.env.NATIVE_MEM_RESTART_THRESHOLD_MB) || 300,
    browserRssRestartThresholdMb: parseInt(process.env.BROWSER_RSS_RESTART_THRESHOLD_MB) || 1500,
    camoufoxExecutablePath: externalCamoufoxExecutable,
    camoufoxCacheDir: camoufoxCacheDir(),
    // Public compatibility names retained for existing callers.
    goliathExecutablePath: externalCamoufoxExecutable,
    goliathCacheDir: camoufoxCacheDir(),
    prometheusEnabled: process.env.PROMETHEUS_ENABLED === '1' || process.env.PROMETHEUS_ENABLED === 'true',
    proxy: {
      strategy: inferProxyStrategy(process.env.PROXY_STRATEGY || ''),
      providerName: process.env.PROXY_PROVIDER || 'decodo',
      host: process.env.PROXY_HOST || '',
      port: process.env.PROXY_PORT || '',
      ports: parseProxyPorts(process.env.PROXY_PORTS, process.env.PROXY_PORT),
      username: process.env.PROXY_USERNAME || '',
      password: process.env.PROXY_PASSWORD || '',
      backconnectHost: process.env.PROXY_BACKCONNECT_HOST || '',
      backconnectPort: parseInt(process.env.PROXY_BACKCONNECT_PORT || '7000', 10),
      country: process.env.PROXY_COUNTRY || '',
      state: process.env.PROXY_STATE || '',
      city: process.env.PROXY_CITY || '',
      zip: process.env.PROXY_ZIP || '',
      sessionDurationMinutes: parseInt(process.env.PROXY_SESSION_DURATION_MINUTES || '10', 10),
    },
    // Env vars forwarded to the server subprocess
    serverEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GOLIATH_ADMIN_KEY: process.env.GOLIATH_ADMIN_KEY,
      GOLIATH_API_KEY: process.env.GOLIATH_API_KEY,
      GOLIATH_ACCESS_KEY: process.env.GOLIATH_ACCESS_KEY,
      GOLIATH_BIND_HOST: process.env.GOLIATH_BIND_HOST || process.env.CAMOFOX_BIND_HOST,
      GOLIATH_COOKIES_DIR: process.env.GOLIATH_COOKIES_DIR,
      GOLIATH_UPLOADS_DIR: process.env.GOLIATH_UPLOADS_DIR,
      GOLIATH_PROFILE_DIR: process.env.GOLIATH_PROFILE_DIR,
      GOLIATH_TRACES_DIR: process.env.GOLIATH_TRACES_DIR,
      GOLIATH_TRACES_MAX_BYTES: process.env.GOLIATH_TRACES_MAX_BYTES,
      GOLIATH_TRACES_TTL_HOURS: process.env.GOLIATH_TRACES_TTL_HOURS,
      GOLIATH_CRASH_REPORT_ENABLED: process.env.GOLIATH_CRASH_REPORT_ENABLED,
      GOLIATH_CRASH_REPORT_URL: process.env.GOLIATH_CRASH_REPORT_URL,
      GOLIATH_EXECUTABLE: process.env.GOLIATH_EXECUTABLE,
      GOLIATH_EXECUTABLE_PATH: process.env.GOLIATH_EXECUTABLE_PATH,
      CAMOFOX_ADMIN_KEY: process.env.CAMOFOX_ADMIN_KEY,
      CAMOFOX_API_KEY: process.env.CAMOFOX_API_KEY,
      CAMOFOX_ACCESS_KEY: process.env.CAMOFOX_ACCESS_KEY,
      CAMOFOX_BIND_HOST: process.env.CAMOFOX_BIND_HOST,
      CAMOFOX_UPLOADS_DIR: process.env.CAMOFOX_UPLOADS_DIR,
      CAMOFOX_COOKIES_DIR: process.env.CAMOFOX_COOKIES_DIR,
      CAMOFOX_PROFILE_DIR: process.env.CAMOFOX_PROFILE_DIR,
      CAMOFOX_TRACES_DIR: process.env.CAMOFOX_TRACES_DIR,
      CAMOFOX_TRACES_MAX_BYTES: process.env.CAMOFOX_TRACES_MAX_BYTES,
      CAMOFOX_TRACES_TTL_HOURS: process.env.CAMOFOX_TRACES_TTL_HOURS,
      CAMOFOX_CRASH_REPORT_ENABLED: process.env.CAMOFOX_CRASH_REPORT_ENABLED,
      CAMOFOX_CRASH_REPORT_URL: process.env.CAMOFOX_CRASH_REPORT_URL,
      CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE,
      CAMOUFOX_EXECUTABLE_PATH: process.env.CAMOUFOX_EXECUTABLE_PATH,
      CAMOUFOX_INSTALL_DIR: process.env.CAMOUFOX_INSTALL_DIR,
      CAMOFOX_EXECUTABLE_PATH: process.env.CAMOFOX_EXECUTABLE_PATH,
      PROXY_STRATEGY: process.env.PROXY_STRATEGY,
      PROXY_PROVIDER: process.env.PROXY_PROVIDER,
      PROXY_HOST: process.env.PROXY_HOST,
      PROXY_PORT: process.env.PROXY_PORT,
      PROXY_PORTS: process.env.PROXY_PORTS,
      PROXY_USERNAME: process.env.PROXY_USERNAME,
      PROXY_PASSWORD: process.env.PROXY_PASSWORD,
      PROXY_BACKCONNECT_HOST: process.env.PROXY_BACKCONNECT_HOST,
      PROXY_BACKCONNECT_PORT: process.env.PROXY_BACKCONNECT_PORT,
      PROXY_COUNTRY: process.env.PROXY_COUNTRY,
      PROXY_STATE: process.env.PROXY_STATE,
      PROXY_CITY: process.env.PROXY_CITY,
      PROXY_ZIP: process.env.PROXY_ZIP,
      PROXY_SESSION_DURATION_MINUTES: process.env.PROXY_SESSION_DURATION_MINUTES,
    },
    // Crash reporter: opt-in and requires an explicit HTTPS relay URL.
    crashReportEnabled:   ['1', 'true'].includes(String(process.env.GOLIATH_CRASH_REPORT_ENABLED || process.env.CAMOFOX_CRASH_REPORT_ENABLED || '').toLowerCase()),
    crashReportUrl:       process.env.GOLIATH_CRASH_REPORT_URL || process.env.CAMOFOX_CRASH_REPORT_URL || '',
    crashReportRateLimit: parseInt(process.env.GOLIATH_CRASH_REPORT_RATE_LIMIT || process.env.CAMOFOX_CRASH_REPORT_RATE_LIMIT, 10) || 10,
    sentryDsn: process.env.SENTRY_DSN || '',
  };
}

export { loadConfig };
