# goliath Agent Guide

Headless browser automation server for AI agents. Run locally or deploy to any cloud provider.

## Quick Start for Agents

```bash
# Install and start
npm install && npm start
# Server runs on http://localhost:9377
```

## Core Workflow

1. **Create a tab** -> Get `tabId`
2. **Navigate** -> Go to URL or use search macro
3. **Get snapshot** -> Receive page content with element refs (`e1`, `e2`, etc.)
4. **Interact** -> Click/type using refs
5. **Repeat** steps 3-4 as needed

## API Reference

### Create Tab
```bash
POST /tabs
{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}
```
Returns: `{"tabId": "abc123", "url": "...", "title": "..."}`

### Navigate
```bash
POST /tabs/:tabId/navigate
{"userId": "agent1", "url": "https://google.com"}
# Or use macro:
{"userId": "agent1", "macro": "@google_search", "query": "weather today"}
```

### Get Snapshot
```bash
GET /tabs/:tabId/snapshot?userId=agent1
```
Returns accessibility tree with refs:
```
[heading] Example Domain
[paragraph] This domain is for use in examples.
[link e1] More information...
```

### Click Element
```bash
POST /tabs/:tabId/click
{"userId": "agent1", "ref": "e1"}
# Or CSS selector:
{"userId": "agent1", "selector": "button.submit"}
```

### Type Text
```bash
POST /tabs/:tabId/type
{"userId": "agent1", "ref": "e2", "text": "hello world"}
# Add enter: {"userId": "agent1", "ref": "e2", "text": "search query", "pressEnter": true}
```

### Scroll
```bash
POST /tabs/:tabId/scroll
{"userId": "agent1", "direction": "down", "amount": 500}
```

### Hands (multi-step workflow)
Run an ordered list of UI actions against one tab in a single request. Prefer this
over repeated `/click` + `/type` calls when filling multi-field forms. In the
OpenClaw plugin this is the `goliath_hands` tool.

```bash
POST /tabs/:tabId/hands
{
  "userId": "agent1",
  "steps": [
    { "action": "type", "ref": "e1", "text": "Carlos" },
    { "action": "type", "ref": "e2", "text": "carlos@example.com" },
    { "action": "select", "selector": "select#country", "value": "BR" },
    { "action": "click", "ref": "e3" }
  ],
  "humanized": { "profile": "balanced" }
}
```

Actions: `click`, `type`, `select`, `check`, `wait`, `scroll`, `press`, `submit`.

Constraints (enforced server-side):
- Max **20 steps** per hand; split larger forms into multiple hands.
- `type.text` max **3000 chars**. `mode` is `fill` (default) or `keyboard`.
- `type` in `fill` mode requires `ref` or `selector`; in `keyboard` mode a target
  is optional (types into current focus).
- `select` **requires a CSS `selector`** — native `<select>` is not exposed as an
  accessibility ref. Use `value` (string) or `values` (array of strings).
- `click` and `check` require `ref` or `selector`; `press` requires `key`.
- `wait.ms` clamps to a max of **5000** (default 300).
- `humanized` accepts a boolean or `{profile: "fast"|"balanced"|"deliberate"}`.

Stops at the first failing step. Response (for the 4-step request above, where
the final click fails):

```json
{
  "ok": false,
  "completed": 3,
  "total": 4,
  "url": "https://example.com/form",
  "results": [
    { "index": 0, "action": "type", "ok": true, "mode": "fill" },
    { "index": 1, "action": "type", "ok": true, "mode": "fill" },
    { "index": 2, "action": "select", "ok": true, "values": ["BR"] },
    { "index": 3, "action": "click", "ok": false, "error": "Unknown ref: e3 ..." }
  ],
  "failedStep": 3
}
```

`ok` is `false` when any step fails; `failedStep` is then the 0-based index of
the first failing step. `completed` counts only successful steps. `results[]`
lists every step attempted (up to and including the failure), each carrying
`index`, `action`, `ok`, and the action's output (or `error` on failure). Refs
invalidate after any step that may navigate (`click`, `submit`, or `type` with
`submit`/`pressEnter`) — refresh the snapshot before targeting elements on the
next page.

### Navigation
```bash
POST /tabs/:tabId/back     {"userId": "agent1"}
POST /tabs/:tabId/forward  {"userId": "agent1"}
POST /tabs/:tabId/refresh  {"userId": "agent1"}
```

### Get Links
```bash
GET /tabs/:tabId/links?userId=agent1&limit=50
```

### Close Tab
```bash
DELETE /tabs/:tabId?userId=agent1
```

## Search Macros

Use these instead of constructing URLs:

| Macro | Site |
|-------|------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@linkedin_search` | LinkedIn |

## Element Refs

Refs like `e1`, `e2` are stable identifiers for page elements:

1. Call `/snapshot` to get current refs
2. Use ref in `/click` or `/type`
3. Refs reset on navigation - get new snapshot after

## Session Management

- `userId` isolates cookies/storage between users
- `sessionKey` groups tabs by conversation/task (legacy: `listItemId` also accepted)
- Sessions timeout after 30 minutes of inactivity
- Delete all user data: `DELETE /sessions/:userId`

## Running Engines

### Goliath (Default)
```bash
npm start
# Or: ./run.sh
```
Firefox-based with configurable anti-detection measures. CAPTCHA or bot-detection acceptance is not guaranteed.

## Testing

```bash
npm run build                     # Type-check and compile the OpenClaw plugin
npm run generate-openapi          # Refresh the committed API specification
npm test                          # Unit, package-integrity, and OpenAPI tests
npx jest tests/unit/openapi.test.js
```

## Docker

```bash
docker build -t goliath .
docker run -p 9377:9377 goliath
```

## Key Files

- `server.js` - Goliath engine (routes + browser logic only -- NO `process.env` or `child_process`)
- `lib/openapi.js` - OpenAPI spec generation via swagger-jsdoc + docs route setup
- `lib/config.js` - All `process.env` reads centralized here
- `plugins/youtube/youtube.js` - YouTube transcript extraction via yt-dlp (`child_process` isolated here)
- `lib/launcher.js` - Subprocess spawning (`child_process` isolated here)
- `lib/cookies.js` - Cookie file I/O
- `lib/metrics.js` - Prometheus metrics (lazy-loaded, off by default -- set `PROMETHEUS_ENABLED=1`)
- `lib/request-utils.js` - HTTP request classification helpers (`actionFromReq`, `classifyError`)
- `lib/snapshot.js` - Accessibility tree snapshot
- `lib/macros.js` - Search macro URL expansion
- `lib/plugins.js` - Plugin loader and event bus
- `lib/auth.js` - Shared auth middleware (API key / loopback)
- `goliath.config.json` - Plugin configuration (which plugins to load)
- `plugins/` - Plugin directory (loaded per goliath.config.json)
- `plugins/youtube/` - Default plugin: YouTube transcript extraction
- `scripts/install-plugin-deps.sh` - Installs plugin deps (apt.txt + post-install.sh)
- `plugins/vnc/index.js` - VNC plugin routes (no `child_process` -- spawning isolated in `vnc-launcher.js`)
- `plugins/vnc/vnc-launcher.js` - VNC process management (`child_process` isolated here)
- `plugins/persistence/index.js` - Session persistence lifecycle hooks
- `lib/persistence.js` - Atomic storage state read/write
- `lib/inflight.js` - Inflight request coalescing
- `lib/tmp-cleanup.js` - Orphaned temp file cleanup
- `lib/reporter.js` - Opt-in crash/hang reporter with anonymization and an operator-configured HTTPS relay
- `Dockerfile` - Production container with default plugin deps pre-installed

## OpenAPI Spec (REQUIRED for route changes)

The API spec is auto-generated from `@openapi` JSDoc comments in `server.js` via [swagger-jsdoc](https://github.com/Surnet/swagger-jsdoc). It's served at `GET /openapi.json` (machine-readable) and `GET /docs` ([swagger-stripey](https://github.com/skyfallsin/swagger-stripey) three-panel UI).

**When adding, modifying, or removing a route, you MUST update the `@openapi` JSDoc block above it.**

Every route handler in `server.js` has a JSDoc comment block directly above it like:

```js
/**
 * @openapi
 * /tabs/{tabId}/click:
 *   post:
 *     tags: [Interaction]
 *     summary: Click an element
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               ref:
 *                 type: string
 *     responses:
 *       200:
 *         description: Click result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/click', async (req, res) => {
```

**Rules:**
- New routes: add a `@openapi` JSDoc block immediately above the `app.get/post/delete(...)` call
- Path params use `{tabId}` syntax (not `:tabId`) in the JSDoc YAML
- Tag must be one of: `System`, `Tabs`, `Navigation`, `Interaction`, `Content`, `Sessions`, `Browser`, `Legacy`
- Every operation must have `tags`, `summary`, and `responses`
- Include `requestBody` for POST/PUT/DELETE routes that accept JSON
- Include `parameters` for path params and required query params
- Mark backward-compat endpoints with `deprecated: true`
- Removing a route: delete the `@openapi` block along with the handler
- **After any route change, run `npm run generate-openapi`** to regenerate the committed `openapi.json`. The test suite will fail if it's stale.
- Run `npx jest tests/unit/openapi.test.js` to verify coverage -- the test fails if any route is missing from the spec, if a stale route exists, or if `openapi.json` is out of date
- Reusable schemas go in `components.schemas` in `lib/openapi.js` (the `swaggerDefinition`); reference them via `$ref: '#/components/schemas/Name'`

## Telemetry

**No credentials or telemetry destination are embedded in this package.** `lib/reporter.js` sends anonymized crash/hang telemetry only when an operator explicitly enables it and configures a trusted HTTPS relay.

- **Architecture**: `lib/reporter.js` (client, no secrets, no `fs`) -> operator-configured HTTPS endpoint
- **`lib/reporter.js`** has zero credentials, private keys, or `fs` imports. It only calls `fetch()` when both telemetry settings are valid.
- **`lib/resources.js`** handles `fs`-based resource snapshots (reading `/proc` on Linux) -- separated from `reporter.js` so no file-read + network-send pattern exists in any single file. No `child_process` import.
- **Anonymization** uses text scrubbing (`anonymize()`) and count-based tab health tracking (`createTabHealthTracker()`). URLs, domains, page content, cookies, and tokens are not collected.
- Reporting is disabled by default. Enabling it requires both `GOLIATH_CRASH_REPORT_ENABLED=true` and an explicit HTTPS `GOLIATH_CRASH_REPORT_URL`.

## Code Separation Conventions

The codebase separates concerns across files for clarity and auditability:

- **Configuration**: `process.env` reads live in `lib/config.js`, which exports a plain config object. No other file reads environment variables directly.
- **Subprocess management**: `child_process` usage lives in dedicated launcher modules (`lib/launcher.js`, `plugins/youtube/youtube.js`, `plugins/vnc/vnc-launcher.js`), not in route handlers.
- **Route handlers**: `server.js` defines Express routes but delegates env/config reads and subprocess spawning to the modules above.
- **Metrics**: `lib/metrics.js` lazy-loads prom-client. `lib/request-utils.js` handles HTTP method classification.

When adding features that need env vars or subprocesses, put that code in a `lib/` module and import the result into `server.js`.

## Plugin System

Plugins extend goliath with new endpoints, background processes, and lifecycle hooks. The server auto-loads all plugins from `plugins/<name>/index.js` on startup.

### Creating a Plugin

```
plugins/
  my-plugin/
    index.js        Required -- exports register(app, ctx)
    apt.txt         Optional -- system packages (one per line)
    post-install.sh Optional -- executable hook for binary downloads
    *.test.js       Optional -- Jest tests (auto-discovered)
```

```js
// plugins/my-plugin/index.js

export function register(app, ctx) {
  const { sessions, config, log, events, auth, ensureBrowser, getSession, destroySession,
          withUserLimit, safePageClose, normalizeUserId, validateUrl, safeError,
          buildProxyUrl, proxyPool, failuresTotal } = ctx;

  // Register Express routes (auth() enforces API key or loopback)
  app.get('/my-endpoint', auth(), async (req, res) => {
    const session = sessions.get(req.params.userId);
    res.json({ ok: true });
  });

  // Listen to lifecycle events
  events.on('browser:launched', ({ browser, display }) => {
    log('info', 'browser is up', { display });
  });

  events.on('session:created', ({ userId, context }) => {
    log('info', 'new session', { userId });
  });

  events.on('tab:navigated', ({ userId, tabId, url }) => {
    log('info', 'navigation', { userId, tabId, url });
  });
}
```

### Plugin Context (`ctx`)

| Property | Type | Description |
|----------|------|-------------|
| `sessions` | `Map` | Live sessions: `userId -> { context, tabGroups, lastAccess }` |
| `config` | `object` | Server CONFIG (port, apiKey, nodeEnv, proxy, etc.) |
| `log` | `function` | `log(level, msg, fields)` -- structured JSON logging |
| `events` | `EventEmitter` | Plugin event bus (29 events -- see below) |
| `auth` | `function` | `auth()` returns Express middleware enforcing API key / loopback |
| `ensureBrowser` | `async function` | Launch browser if not running, return browser instance |
| `getSession` | `async function` | `getSession(userId)` -- get or create a session |
| `destroySession` | `function` | `destroySession(userId)` -- tear down a session |
| `withUserLimit` | `async function` | `withUserLimit(userId, fn)` -- run `fn` within per-user concurrency limit |
| `safePageClose` | `async function` | `safePageClose(page)` -- close a page with timeout guard |
| `normalizeUserId` | `function` | `normalizeUserId(id)` -- coerce to string for map keys |
| `validateUrl` | `function` | `validateUrl(url)` -- returns error string or null |
| `safeError` | `function` | `safeError(err)` -- sanitize error for client response |
| `buildProxyUrl` | `function` | `buildProxyUrl(pool, proxyConfig)` -- get proxy URL for external requests |
| `proxyPool` | `object\|null` | Proxy pool instance (null if no proxy configured) |
| `failuresTotal` | `Counter` | Prometheus counter: `failuresTotal.labels(type, action).inc()` |
| `createMetric` | `async function` | Create a Prometheus metric registered to the shared registry (see below) |
| `metricsRegistry` | `function` | `metricsRegistry()` -- raw prom-client Registry or null |

### Events (30)

29 emitted by core, 1 (`session:storage:export`) emitted by plugins.

#### Browser Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `browser:launching` | `{ options }` | (ok) Modify launch options in-place |
| `browser:launched` | `{ browser, display }` | |
| `browser:restart` | `{ reason }` | |
| `browser:closed` | `{ reason }` | |
| `browser:error` | `{ error }` | |

#### Session Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `session:creating` | `{ userId, contextOptions }` | (ok) Modify context options in-place |
| `session:created` | `{ userId, context }` | |
| `session:destroyed` | `{ userId, reason }` | |
| `session:expired` | `{ userId, idleMs }` | |

#### Tab Lifecycle
| Event | Payload |
|-------|---------|
| `tab:created` | `{ userId, tabId, page, url }` |
| `tab:navigated` | `{ userId, tabId, url, prevUrl }` |
| `tab:destroyed` | `{ userId, tabId, reason }` |
| `tab:recycled` | `{ userId, tabId }` |
| `tab:error` | `{ userId, tabId, error }` |

#### Content
| Event | Payload |
|-------|---------|
| `tab:snapshot` | `{ userId, tabId, snapshot }` |
| `tab:screenshot` | `{ userId, tabId, buffer }` |
| `tab:evaluate` | `{ userId, tabId, expression }` |
| `tab:evaluated` | `{ userId, tabId, result }` |

#### Input
| Event | Payload |
|-------|---------|
| `tab:click` | `{ userId, tabId, ref, selector }` |
| `tab:type` | `{ userId, tabId, text, ref, mode }` |
| `tab:scroll` | `{ userId, tabId, direction, amount }` |
| `tab:press` | `{ userId, tabId, key }` |
| `tab:upload` | `{ userId, tabId, count }` |

#### Downloads
| Event | Payload |
|-------|---------|
| `tab:download:start` | `{ userId, tabId, filename, url }` |
| `tab:download:complete` | `{ userId, tabId, filename, path, size }` |

#### Cookies / Auth
| Event | Payload |
|-------|---------|
| `session:cookies:import` | `{ userId, count }` |
| `session:storage:export` | `{ userId }` |

#### Server
| Event | Payload |
|-------|---------|
| `server:starting` | `{ port }` |
| `server:started` | `{ port, pid }` |
| `server:shutdown` | `{ signal }` |

### Mutating Hooks

`browser:launching`, `session:creating`, `session:created`, and `session:destroyed` are emitted via `events.emitAsync()` -- the server awaits all listeners (including async ones) before proceeding. This ensures async work like loading storage state from disk completes before the context is created.

Other events use regular `events.emit()` (fire-and-forget).

Modify payload objects in-place:

```js
// Change Xvfb resolution (e.g., for VNC plugin)
events.on('browser:launching', ({ options }) => {
  options.virtual_display_resolution = '1920x1080x24';
});

// Inject saved auth state into new sessions
events.on('session:creating', ({ userId, contextOptions }) => {
  const saved = loadStorageState(userId);
  if (saved) contextOptions.storageState = saved;
});
```

### System Packages (`apt.txt`) and Post-Install Hooks

Plugins that need system packages list them one per line in `apt.txt`:

```
# plugins/vnc/apt.txt
x11vnc
novnc
python3-websockify
```

For binary downloads or setup not available via apt, add an executable `post-install.sh`:

```bash
# plugins/youtube/post-install.sh
#!/bin/sh
set -e
curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

Both are run by `scripts/install-plugin-deps.sh` during Docker build.

### Configuration (`goliath.config.json`)

`goliath.config.json` controls which plugins are loaded at runtime and during Docker build:

```json
{
  "id": "goliath",
  "name": "Goliath",
  "version": "0.1.0",
  "plugins": {
    "youtube": { "enabled": true },
    "persistence": { "enabled": true },
    "vnc": { "enabled": false, "resolution": "1920x1080" }
  }
}
```

- **`plugins`** -- an object with per-plugin settings, or a backward-compatible array of names. Only enabled/listed plugins load at startup and have dependencies installed during a Docker build.
- If the file is missing or has no `plugins` key, **all** plugins in `plugins/` are loaded (backward-compatible).
- This is goliath's own config. `openclaw.plugin.json` is separate -- it tells the OpenClaw Gateway how to configure goliath as an external service.

### Installing Plugins

Use the plugin manager to install third-party plugins from git or local paths:

```bash
# Install from git
npm run plugin install https://github.com/user/goliath-screenshot-plugin
npm run plugin install git:github.com/user/my-plugin

# Install from local directory
npm run plugin install ./path/to/my-plugin

# List installed plugins
npm run plugin list

# Remove a plugin
npm run plugin remove my-plugin
```

The installer copies the plugin into `plugins/`, adds it to `goliath.config.json`, and runs `npm install` for any npm dependencies. System deps (`apt.txt`, `post-install.sh`) are flagged but must be installed manually or via Docker rebuild.

Plugin sources can be:
- **Git repos** where the root has `index.js` with `register()` (installed as one plugin)
- **Git repos** with a `plugins/` subdirectory (each subdirectory installed as a separate plugin)
- **Local directories** with `index.js` and `register()`

### Default Plugins

Three plugins ship by default:

- **youtube** -- YouTube transcript extraction (enabled by default)
- **persistence** -- Per-user session state persistence to `~/.goliath/profiles/` (enabled by default)
- **vnc** -- Interactive browser login via noVNC (disabled by default, requires `ENABLE_VNC=1`)

The `youtube` plugin ships as a default plugin -- it's listed in `goliath.config.json` and included in the base Docker image with its deps pre-installed. The base image runs `scripts/install-plugin-deps.sh` which reads the config and installs `apt.txt` packages + `post-install.sh` hooks for listed plugins.

The `with-plugins` Dockerfile stage is for rebuilding after adding third-party plugins:

```bash
docker build --target with-plugins -t goliath .
```

The `with-plugins` stage re-runs `install-plugin-deps.sh` to pick up any new plugins added to `plugins/`.

### Code Separation Rules

Plugins follow the same separation conventions as core (see "Code Separation Conventions" above):
- **No `process.env` in plugin files that also have route handlers** -- read config from `ctx.config`
- **No `child_process` in plugin files that also have route handlers** -- spawn from a separate `lib/` module

### Custom Metrics

Plugins create Prometheus metrics via `ctx.createMetric()`. Returns a no-op stub when Prometheus is disabled -- no null checks needed.

```js
// In register(app, ctx):
const transcriptsTotal = await ctx.createMetric('counter', {
  name: 'goliath_youtube_transcripts_total',
  help: 'YouTube transcripts extracted',
  labelNames: ['method'],
});

// Use anywhere -- works whether Prometheus is enabled or not
transcriptsTotal.labels('yt-dlp').inc();
```

Supported types: `'counter'`, `'histogram'`, `'gauge'`. Options are standard [prom-client](https://github.com/siimon/prom-client) options (`name`, `help`, `labelNames`, `buckets`, etc.). Metrics auto-register to the shared registry and appear on `/metrics`.

For advanced use, `ctx.metricsRegistry()` returns the raw prom-client `Registry` (or `null` when disabled).

### Example: YouTube Transcript Plugin

The YouTube plugin (`plugins/youtube/`) is the reference implementation. It extracts transcripts via yt-dlp with browser fallback, using `ctx` helpers for auth, logging, browser access, and concurrency control.

```
plugins/
  youtube/
    index.js        # register(app, ctx) -- route handler + browser fallback
    youtube.js      # yt-dlp process management + transcript parsing
    youtube.test.js # parser unit tests
    apt.txt         # python3-minimal (yt-dlp runtime dep)
    post-install.sh # downloads yt-dlp binary
```

```js
// plugins/youtube/index.js (simplified)
import { detectYtDlp, hasYtDlp, ensureYtDlp, ytDlpTranscript } from './youtube.js';
import { classifyError } from '../../lib/request-utils.js';

export async function register(app, ctx) {
  const { log, config, sessions, ensureBrowser, getSession,
          withUserLimit, safePageClose, normalizeUserId,
          validateUrl, safeError, buildProxyUrl, proxyPool,
          failuresTotal } = ctx;

  await detectYtDlp(log);

  app.post('/youtube/transcript', ctx.auth(), async (req, res) => {
    // ... validate URL, extract videoId, try yt-dlp then browser fallback
  });

  async function browserTranscript(reqId, url, videoId, lang) {
    return await withUserLimit('__yt_transcript__', async () => {
      await ensureBrowser();
      const session = await getSession('__yt_transcript__');
      const page = await session.context.newPage();
      // ... intercept captions, parse transcript
      await safePageClose(page);
    });
  }
}
```

Key patterns:
- **Auth**: `ctx.auth()` middleware on the route
- **Logging**: `ctx.log('info', ...)` -- never `console.log`
- **Browser access**: `ctx.ensureBrowser()` + `ctx.getSession()` for browser-backed features
- **Concurrency**: `ctx.withUserLimit()` to respect per-user limits
- **Metrics**: `ctx.failuresTotal.labels(...)` for core counters, `ctx.createMetric()` for custom
- **Code separation**: `child_process` in `youtube.js`, route handler in `index.js` -- separate files
- **System deps**: `apt.txt` lists packages installed via `scripts/install-plugin-deps.sh`
