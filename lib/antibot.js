/**
 * Generic anti-bot wall detection and challenge handling.
 *
 * Field reports show the same failure shape across vendors (PerimeterX/HUMAN,
 * DataDome, Cloudflare): the page renders, fields fill, and then every real
 * interaction is swallowed with no request leaving the browser. Detection here
 * is vendor-agnostic and read-only. Driving a visible challenge goes through
 * the shared humanized input layer, never through raw injected clicks.
 *
 * No process.env access and no child_process: configuration arrives as
 * arguments from lib/config.js so this module stays audit-friendly.
 */

const WALL_HOSTS = {
  perimeterx: [/captcha-delivery\.com/i, /perimeterx\.net/i, /px-cdn\.net/i, /px-cloud\.net/i],
  datadome: [/datadome\.co/i, /ddmcdn\.com/i],
  cloudflare: [/challenges\.cloudflare\.com/i],
  hcaptcha: [/hcaptcha\.com/i],
  recaptcha: [/recaptcha/i, /gstatic\.com\/recaptcha/i],
  turnstile: [/challenges\.cloudflare\.com\/turnstile/i],
};

const SILENT_BLOCK_PHRASES = [
  /access (is )?denied/i,
  /are you a (robot|human)/i,
  /unusual traffic/i,
  /verify (that )?you are/i,
  /(please )?(verify|confirm) you are human/i,
  /press and hold/i,
  /request (was )?blocked/i,
  /something went wrong\. please try again/i,
  /too many requests/i,
];

const DRIVE_TARGETS = [
  'input[type=checkbox]',
  '#px-captcha',
  '.px-captcha-container',
  '#px-captcha-modal',
  '.px-captcha-hold-button',
  '[role=checkbox]',
  '.slider',
  '[aria-label*="verify" i]',
  'button[aria-label*="hold" i]',
  '[id*="captcha" i]',
  '[class*="captcha" i]',
  '[id*="challenge" i]',
  'canvas',
  'div[role=button]',
  'button',
];

// Host fragments used to find the challenge iframe in the page, for the
// coordinate fallback when the frame exposes no addressable element.
const CHALLENGE_FRAME_HOSTS = ['px-cloud', 'captcha-delivery', 'perimeterx', 'datadome', 'cloudflare'];

const PRESS_HOLD_PHRASES = [/press\s*(and|&)\s*hold/i, /press and hold to confirm/i];

export const WALL_VENDORS = Object.freeze(Object.keys(WALL_HOSTS));
export const WALL_STATES = Object.freeze(['clear', 'challenge', 'silent', 'none']);

function hostMatches(vendor, url) {
  return WALL_HOSTS[vendor].some(re => re.test(url || ''));
}

function matchingVendors(urls) {
  const found = new Set();
  for (const url of urls) {
    for (const vendor of WALL_VENDORS) if (hostMatches(vendor, url)) found.add(vendor);
  }
  return [...found];
}

function silentPhrase(text) {
  const value = String(text || '');
  for (const re of SILENT_BLOCK_PHRASES) if (re.test(value)) return re.source;
  return null;
}

/**
 * Read the current wall state from the page. `response` is the optional
 * Playwright response for the navigation that produced the page; its status
 * and headers sharpen a header-only block into a silent verdict.
 */
export async function detectWall(page, { response = null, sample = null } = {}) {
  const checkedAt = Date.now();
  if (!page || typeof page.evaluate !== 'function') {
    return { vendor: null, state: 'none', evidence: [], checkedAt, error: 'no-page' };
  }
  let raw = sample;
  if (!raw) {
    raw = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean);
      const frames = Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean);
      const globals = Object.keys(window).filter(k => /^(_px|px[A-Z_]|_cf|turnstile|dataDome|_ddm)/.test(k));
      const cookies = document.cookie ? document.cookie.split(';').map(c => c.trim().split('=')[0]) : [];
      const interactive = document.querySelectorAll('a[href], button, input, select, textarea, [role=button]').length;
      return {
        url: location.href,
        scripts,
        frames,
        globals,
        cookies,
        interactive,
        bodyText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 800),
      };
    }).catch(err => ({ error: String(err && err.message ? err.message : err) }));
  }

  const urls = [...(raw.scripts || []), ...(raw.frames || [])];
  const vendors = new Set(matchingVendors(urls));
  const globals = raw.globals || [];
  if (globals.some(g => /^_px|^px[A-Z_]/.test(g))) vendors.add('perimeterx');
  if (globals.some(g => /^dataDome|^_ddm/.test(g))) vendors.add('datadome');
  if (globals.some(g => /^_cf|^turnstile/.test(g))) vendors.add('cloudflare');
  if ((raw.cookies || []).some(c => /^_px/i.test(c))) vendors.add('perimeterx');
  if ((raw.cookies || []).some(c => /^datadome/i.test(c))) vendors.add('datadome');

  const status = response && typeof response.status === 'function' ? response.status() : null;
  const challengeFrame = (raw.frames || []).find(url => matchingVendors([url]).length > 0) || null;
  const challengeScript = (raw.scripts || []).find(url => matchingVendors([url]).length > 0) || null;
  const phrase = silentPhrase(raw.bodyText);

  const evidence = [];
  if (challengeFrame) evidence.push({ kind: 'frame', url: challengeFrame });
  if (challengeScript) evidence.push({ kind: 'script', url: challengeScript });
  if (globals.length) evidence.push({ kind: 'globals', names: globals.slice(0, 6) });
  if (status) evidence.push({ kind: 'status', status });

  const vendor = vendors.size ? [...vendors][0] : null;

  // A press-and-hold wall renders in the main document rather than in a frame
  // (observed on PerimeterX `Press & Hold to confirm you are a human`), so the
  // copy itself is the challenge marker. It stays drivable, not a silent block.
  const pressHold = !!vendor && PRESS_HOLD_PHRASES.some(re => re.test(String(raw.bodyText || '')));
  if (pressHold) evidence.push({ kind: 'press-hold' });

  let state = 'none';
  let kind = null;
  if (challengeFrame) { state = 'challenge'; kind = 'frame-challenge'; }
  else if (pressHold) { state = 'challenge'; kind = 'press-hold'; }
  else if (vendors.size && (status === 403 || status === 429 || status === 503)) { state = 'silent'; kind = 'silent-block'; }
  else if (vendors.size && raw.interactive === 0 && phrase) { state = 'silent'; kind = 'silent-block'; }
  else if (vendors.size && phrase) { state = 'silent'; kind = 'silent-block'; }
  else if (vendor) state = 'clear';

  return {
    vendor,
    vendors: [...vendors],
    state,
    kind,
    evidence,
    challengeFrame,
    phrase,
    status,
    interactive: raw.interactive ?? null,
    url: raw.url || null,
    error: raw.error || null,
    checkedAt,
  };
}

/** True when the wall is present and nothing progressed. */
export function wallIsBlocking(wall) {
  return !!wall && (wall.state === 'challenge' || wall.state === 'silent');
}

/**
 * Transient (non-blocking) vendors keep a marker on ordinary pages; only a
 * blocking state is worth a verdict, so callers use this to decide.
 */
export function wallSummary(wall) {
  if (!wall) return null;
  return {
    vendor: wall.vendor || null,
    state: wall.state || 'none',
    blocking: wallIsBlocking(wall),
    challengeFrame: wall.challengeFrame || null,
    checkedAt: wall.checkedAt || null,
  };
}

/** Typed verdict the calling agent can branch on, e.g. `perimeterx:blocked`. */
export function wallError(wall, { egressClass = null, triedProfiles = [], attempts = 1, url = null } = {}) {
  const vendor = (wall && wall.vendor) || 'antibot';
  const error = new Error(
    `Anti-bot wall (${vendor}) still blocking after ${attempts} attempt(s) from egress class ${egressClass || 'unknown'}`,
  );
  error.code = `${vendor}:blocked`;
  error.statusCode = 403;
  error.retrySafe = false;
  error.vendor = vendor;
  error.wallState = (wall && wall.state) || 'silent';
  error.egressClass = egressClass;
  error.triedProfiles = triedProfiles;
  error.url = url;
  error.hint = 'Change the egress profile or route this flow elsewhere; retrying from the same network class will repeat the block.';
  return error;
}

/**
 * Count page requests during `fn` so a swallowed action can be told apart from
 * a slow one. Returns the requests observed while the action ran.
 */
export async function observeRequests(page, fn, { settleMs = 0 } = {}) {
  const seen = [];
  const onRequest = request => seen.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
  page.on?.('request', onRequest);
  try {
    await fn();
    if (settleMs > 0 && typeof page.waitForTimeout === 'function') await page.waitForTimeout(settleMs);
  } finally {
    page.off?.('request', onRequest);
  }
  return seen;
}

export function meaningfulRequests(requests = []) {
  return requests.filter(r => r.resourceType !== 'image' && !/px\.gif|beacon|analytics|collect\?/i.test(r.url));
}

/**
 * Drive a visible challenge with the native input layer: real pointer path,
 * real press cadence. Returns what actually happened rather than asserting
 * success. `humanizedClick` and `humanizedPressAndHold` are injected so this
 * module stays testable without a browser.
 */
/**
 * Locate the challenge iframe in the page and build a locator-like handle for
 * its centre, so a frame with no addressable control can still be pressed.
 */
async function findCoordinateTarget(page, { minWidth = 40, minHeight = 30 } = {}) {
  if (typeof page.locator !== 'function') return null;
  for (const host of CHALLENGE_FRAME_HOSTS) {
    const frameLocator = page.locator(`iframe[src*="${host}"]`).first();
    const count = await frameLocator.count().catch(() => 0);
    if (!count) continue;
    const box = await frameLocator.boundingBox().catch(() => null);
    if (!box || box.width < minWidth || box.height < minHeight) continue;
    return {
      selector: `coordinate:center(iframe[src*="${host}"])`,
      locator: {
        boundingBox: async () => box,
        scrollIntoViewIfNeeded: async () => {},
        evaluate: async () => ({ hit: true }),
      },
    };
  }
  return null;
}

export async function driveChallenge(page, wall, { humanizedClick, humanizedPressAndHold, state, options = {}, holdMs = 4200, waitMs = 5000 } = {}) {
  if (!page || !wall || wall.state !== 'challenge') return { attempted: false, outcome: 'not-applicable', detail: 'no visible challenge' };
  if (typeof humanizedClick !== 'function') return { attempted: false, outcome: 'unsupported', detail: 'no humanized click available' };

  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const vendorFrames = frames.filter(frame => {
    try { return matchingVendors([frame.url()]).length > 0; } catch { return false; }
  });
  const candidates = [];
  const seen = new Set();
  for (const frame of [...vendorFrames, ...frames]) {
    let key;
    try { key = frame.url(); } catch { key = `frame-${candidates.length}`; }
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(frame);
  }

  let target = null;
  let targetFrame = null;
  for (const frame of candidates) {
    for (const selector of DRIVE_TARGETS) {
      const locator = frame.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0 && await locator.isVisible().catch(() => false)) { target = { selector, locator }; targetFrame = frame; break; }
    }
    if (target) break;
  }

  // PerimeterX press-and-hold renders inside the frame as an unaddressable
  // surface, so fall back to a real press-and-hold on the frame's own centre.
  let coordinateHold = false;
  if (!target) {
    target = await findCoordinateTarget(page);
    coordinateHold = !!target;
  }
  if (!target) {
    return { attempted: false, outcome: 'unsupported', detail: 'no drivable element inside the challenge (neither an addressable control nor a frame box)' };
  }
  if (targetFrame) target.selector = `${target.selector} @ ${(() => { try { return targetFrame.url().slice(0, 80); } catch { return 'frame'; } })()}`;

  const before = await observeRequests(page, async () => {
    if (typeof humanizedPressAndHold === 'function' && holdMs > 0) {
      await humanizedPressAndHold(page, target.locator, state, { ...options, ...(coordinateHold ? { strictHitTarget: false } : {}), holdMs });
    } else {
      await humanizedClick(page, target.locator, state, options);
    }
  }, { settleMs: waitMs });

  const after = await detectWall(page);
  const sent = meaningfulRequests(before);
  const cleared = !wallIsBlocking(after) || after.state === 'clear';
  return {
    attempted: true,
    outcome: cleared ? 'cleared' : 'still-challenging',
    detail: cleared ? 'challenge cleared after native input' : `wall still ${after.state}`,
    selector: target.selector,
    requestsSent: sent.length,
    requests: sent.slice(0, 5),
    wall: wallSummary(after),
  };
}
