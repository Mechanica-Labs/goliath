// Browser runtime installation for Goliath.
//
// Goliath drives the public `camoufox-js` runtime. That package ships a `fetch`
// CLI, but it renders its own progress bar and prints directly to stdout, which
// makes it impossible to present a coherent installer UI. This module reuses the
// parts worth reusing -- release resolution (GitHub API auth, version range
// constraints, OS/arch matrix) and zip extraction -- while owning the download
// itself so progress can be reported through `onEvent` and rendered by the caller.
//
// It also improves on the upstream ordering. `CamoufoxFetcher.install()` deletes
// the existing install *before* downloading, so a network failure leaves the user
// with no runtime at all. Here the archive is fully downloaded to a temp file
// first, and the existing install is only replaced once the bytes are on disk.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

export const LINUX_BROWSER_APT_PACKAGES = [
  'libgtk-3-0',
  'libdbus-glib-1-2',
  'libxt6',
  'libasound2t64',
  'libx11-xcb1',
  'libxcomposite1',
  'libxcursor1',
  'libxdamage1',
  'libxfixes3',
  'libxi6',
  'libxrandr2',
  'libxrender1',
  'libxss1',
  'libxtst6',
  'libegl1',
  'libgl1-mesa-dri',
  'libgbm1',
  'xvfb',
  'fonts-liberation',
  'fonts-noto-color-emoji',
  'fontconfig',
];

export const LINUX_BROWSER_APT_PACKAGE_CANDIDATES = LINUX_BROWSER_APT_PACKAGES.map((name) => {
  if (name === 'libasound2t64') return ['libasound2t64', 'libasound2'];
  return [name];
});

export const EXTERNAL_EXECUTABLE_ENV_VARS = [
  'GOLIATH_EXECUTABLE',
  'GOLIATH_EXECUTABLE_PATH',
  'CAMOUFOX_EXECUTABLE',
  'CAMOUFOX_EXECUTABLE_PATH',
  'CAMOFOX_EXECUTABLE_PATH',
];

const SKIP_DOWNLOAD_ENV_VARS = ['GOLIATH_SKIP_DOWNLOAD', 'CAMOFOX_SKIP_DOWNLOAD'];

/**
 * Cache directory used by camoufox-js.
 *
 * Mirrors camoufox-js/dist/pkgman.js. The Windows branch nests the app name
 * twice, which looks like an upstream slip but must be matched exactly or the
 * runtime and the installer disagree about where the binary lives.
 */
export function cacheDir(env = process.env, plat = platform()) {
  if (env.CAMOUFOX_INSTALL_DIR) return resolve(env.CAMOUFOX_INSTALL_DIR);
  const home = homedir();
  if (plat === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (plat === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

export function versionFilePath(env = process.env, plat = platform()) {
  return join(cacheDir(env, plat), 'version.json');
}

/** Path of the launchable binary inside the cache, per platform bundle layout. */
export function executablePath(env = process.env, plat = platform()) {
  const dir = cacheDir(env, plat);
  if (plat === 'win32') return join(dir, 'camoufox.exe');
  if (plat === 'darwin') return join(dir, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  return join(dir, 'camoufox-bin');
}

/** Parsed version.json, or null when the runtime is absent or the file is corrupt. */
export function readInstalledVersion(env = process.env, plat = platform()) {
  try {
    const parsed = JSON.parse(readFileSync(versionFilePath(env, plat), 'utf8'));
    if (!parsed?.version) return null;
    return { version: parsed.version, release: parsed.release || '' };
  } catch {
    return null;
  }
}

export function externalExecutableFromEnv(env = process.env) {
  for (const name of EXTERNAL_EXECUTABLE_ENV_VARS) {
    const value = (env[name] || '').trim();
    if (value) return { name, value };
  }
  return null;
}

export function shouldSkipDownload(env = process.env) {
  return SKIP_DOWNLOAD_ENV_VARS.some((name) => env[name] === '1' || env[name] === 'true');
}

/**
 * Report install health.
 *
 * Both the version marker and the executable have to be present: an interrupted
 * extraction can leave one without the other, and the failure then surfaces much
 * later as an opaque launch error.
 */
export function inspectInstall(env = process.env, plat = platform()) {
  const external = externalExecutableFromEnv(env);
  if (external) {
    const exists = existsSync(external.value);
    return {
      kind: 'external',
      installed: exists,
      source: external.name,
      executable: external.value,
      issues: exists ? [] : [`${external.name} points at a missing file: ${external.value}`],
    };
  }

  const marker = readInstalledVersion(env, plat);
  const binary = executablePath(env, plat);
  const hasBinary = existsSync(binary);
  const issues = [];
  if (!marker) issues.push(`missing or unreadable ${versionFilePath(env, plat)}`);
  if (!hasBinary) issues.push(`missing runtime executable: ${binary}`);

  return {
    kind: 'bundled',
    installed: Boolean(marker) && hasBinary,
    version: marker?.version || null,
    release: marker?.release || '',
    executable: binary,
    directory: cacheDir(env, plat),
    issues,
  };
}

function parseMissingLibraries(output) {
  const missing = [];
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/^\s*(\S+)\s+=>\s+not found\s*$/);
    if (match) missing.push(match[1]);
  }
  return [...new Set(missing)].sort();
}

/**
 * Check dynamic-linker dependencies for the Linux runtime executable.
 *
 * This catches the common fresh-server failure where the runtime is downloaded
 * correctly but cannot start because GTK, X11, Mesa, or font packages are
 * missing. It is intentionally separate from inspectInstall(): a runtime can be
 * present on disk and still be unlaunchable.
 */
export async function inspectLinuxRuntimeDependencies({
  env = process.env,
  plat = platform(),
  executable = executablePath(env, plat),
  runFile = null,
} = {}) {
  if (plat !== 'linux') return { ok: true, skipped: true, reason: 'not_linux', missing: [], issues: [] };
  if (!existsSync(executable)) {
    return {
      ok: false,
      skipped: false,
      missing: [],
      issues: [`missing runtime executable: ${executable}`],
    };
  }

  const execFile = runFile || (await import('node:child_process')).execFileSync;
  try {
    const output = execFile('ldd', [executable], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const missing = parseMissingLibraries(output);
    return {
      ok: missing.length === 0,
      skipped: false,
      missing,
      issues: missing.map((name) => `missing shared library: ${name}`),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: false,
        skipped: false,
        missing: [],
        issues: ['ldd is not available; install libc-bin or the equivalent system package'],
      };
    }
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}`;
    const missing = parseMissingLibraries(output);
    return {
      ok: missing.length === 0,
      skipped: false,
      missing,
      issues: missing.length
        ? missing.map((name) => `missing shared library: ${name}`)
        : [`could not inspect runtime dependencies: ${err?.message || err}`],
    };
  }
}

/**
 * Launch and close the browser runtime once. This is the final readiness check:
 * file presence and ldd output do not catch sandbox restrictions in containers.
 */
export async function verifyBrowserLaunch({
  env = process.env,
  plat = platform(),
  timeoutMs = 20_000,
} = {}) {
  const external = externalExecutableFromEnv(env);
  const executable = external?.value || executablePath(env, plat);
  if (!existsSync(executable)) {
    return { ok: false, error: `missing runtime executable: ${executable}` };
  }

  let browser = null;
  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`browser launch timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref();
  });

  try {
    const [{ launchOptions }, { firefox }] = await Promise.all([
      import('camoufox-js'),
      import('playwright-core'),
    ]);
    const options = await launchOptions({
      executable_path: external?.value,
      headless: true,
      humanize: false,
      enable_cache: false,
    });
    browser = await Promise.race([firefox.launch(options), timer]);
    await Promise.race([browser.newPage().then((page) => page.close()), timer]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Free bytes on the volume backing `path`, or null when unavailable.
 *
 * On a first install the cache directory does not exist yet, so this walks up
 * to the nearest existing ancestor. Any ancestor is on the same volume unless a
 * mount point sits in between, which is close enough for a headroom warning.
 */
export function freeDiskBytes(path) {
  let current = path;
  for (;;) {
    try {
      const stats = statfsSync(current);
      return stats.bsize * stats.bavail;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function countingSink(destination, onChunk) {
  return new Writable({
    write(chunk, encoding, callback) {
      onChunk(chunk.length);
      destination.write(chunk, encoding, callback);
    },
    final(callback) {
      destination.end(callback);
    },
  });
}

/**
 * Stream `url` to `destPath`, reporting bytes through `onProgress`.
 *
 * Each attempt restarts from zero: GitHub's asset CDN does serve range requests,
 * but a resumed download that silently mixes bytes from two releases would
 * produce a corrupt archive, and the zip only fails much later during extract.
 */
export async function downloadTo(url, destPath, { onProgress = () => {}, retries = 3, fetchImpl = fetch } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const header = response.headers.get('content-length');
      const total = header ? Number.parseInt(header, 10) : null;
      onProgress({ phase: 'start', total: Number.isFinite(total) ? total : null, attempt });

      let transferred = 0;
      const file = createWriteStream(destPath);
      await pipeline(response.body, countingSink(file, (bytes) => {
        transferred += bytes;
        onProgress({ phase: 'data', transferred, total });
      }));

      if (total && transferred !== total) {
        throw new Error(`truncated download: got ${transferred} of ${total} bytes`);
      }
      return { bytes: transferred };
    } catch (err) {
      lastError = err;
      rmSync(destPath, { force: true });
      if (attempt < retries) {
        onProgress({ phase: 'retry', attempt, error: err.message });
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(`failed to download after ${retries} attempts: ${lastError?.message}`);
}

/**
 * Download and install the browser runtime.
 *
 * Emits lifecycle events through `onEvent` so the caller renders progress; this
 * module never writes to stdout. Returns install metadata on success.
 */
export async function installBrowser({ onEvent = () => {}, env = process.env, plat = platform() } = {}) {
  // Imported lazily so status checks can run even when the dependency tree is
  // partial and only require camoufox-js when an installation is requested.
  const { CamoufoxFetcher } = await import('camoufox-js/dist/pkgman.js');

  onEvent({ type: 'resolve:start' });
  const fetcher = new CamoufoxFetcher();
  await fetcher.init();
  onEvent({ type: 'resolve:done', version: fetcher.version, release: fetcher.release, url: fetcher.url });

  const staging = mkdtempSync(join(tmpdir(), 'goliath-runtime-'));
  const archive = join(staging, 'runtime.zip');

  try {
    const { bytes } = await downloadTo(fetcher.url, archive, {
      onProgress: (progress) => onEvent({ type: 'download', ...progress }),
    });
    onEvent({ type: 'download:done', bytes });

    // Only now is it safe to drop a previously working install.
    onEvent({ type: 'extract:start' });
    const target = cacheDir(env, plat);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    await fetcher.extractZip(archive);
    fetcher.setVersion();
    onEvent({ type: 'extract:done' });

    if (plat !== 'win32') {
      const { execFileSync: runFile } = await import('node:child_process');
      runFile('chmod', ['-R', '755', target]);
    }

    const report = inspectInstall(env, plat);
    if (!report.installed) {
      throw new Error(`install verification failed: ${report.issues.join('; ')}`);
    }
    onEvent({ type: 'done', ...report });
    return report;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Total bytes occupied by the install, for the post-install summary. */
export function installedSize(env = process.env, plat = platform()) {
  const dir = cacheDir(env, plat);
  let total = 0;
  const walk = (path) => {
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        try { total += statSync(child).size; } catch { /* raced with cleanup */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** Compatibility check used by the agent-facing CLI and MCP bridge. */
export function isBrowserInstalled(config) {
  if (config?.camoufoxExecutablePath) return existsSync(config.camoufoxExecutablePath);
  if (config?.camoufoxCacheDir) return existsSync(join(config.camoufoxCacheDir, 'version.json'));
  return inspectInstall(config?.serverEnv || process.env).installed;
}

/**
 * Ensure the runtime exists while preserving the compact stream-oriented API
 * used by `goliath setup`, `goliath serve`, and the MCP bridge.
 */
export async function ensureBrowserInstalled(config, {
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (isBrowserInstalled(config)) return { installed: true, downloaded: false };

  const env = config?.serverEnv || process.env;
  stderr.write('[goliath] Browser engine is missing; downloading Camoufox (one time, about 300 MB).\n');
  const report = await installBrowser({
    env,
    onEvent(event) {
      if (event.type === 'download' && event.phase === 'retry') {
        stderr.write(`[goliath] Download attempt ${event.attempt} failed; retrying.\n`);
      } else if (event.type === 'done') {
        stdout.write(`[goliath] Browser runtime ${event.version || 'installed'} is ready.\n`);
      }
    },
  });
  return { ...report, installed: true, downloaded: true };
}
