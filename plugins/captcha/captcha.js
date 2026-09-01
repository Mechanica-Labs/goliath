/**
 * Captcha solver for goliath.
 *
 * Detects the CAPTCHA type on the current page, solves it via an external
 * provider (2captcha / capsolver) or local OCR, and returns the token/answer
 * for the route handler to fill and submit.
 *
 * Code separation: all `process.env` reads and `child_process` usage live in
 * this file, NOT in index.js (project convention).
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// relative to repo root (plugins/captcha/../../)
const REPO_ROOT = path.join(__dirname, '..', '..');
const MAX_CAPTCHA_INSTRUCTION_CHARS = 32_000;

// A real CAPTCHA may ask a person to select images, tick a checkbox, or type
// text from an image. It should never ask the operator to open a local command
// runner, paste a command, or disclose a secret. ClickFix campaigns combine
// those instructions to turn a "verification" prompt into local code
// execution. Keep the detection deliberately conjunctive so normal challenge
// copy is not treated as hostile.
const SUSPICIOUS_CAPTCHA_INSTRUCTION_RULES = [
  {
    id: 'clickfix_command_execution',
    pattern: /(?:press|hold|use|open|launch).{0,80}(?:windows?\s*(?:key)?\s*\+?\s*r|win\s*\+?\s*r|run dialog|terminal|powershell|command prompt|cmd(?:\.exe)?|shell).{0,180}(?:paste|ctrl\s*\+?\s*v|command|code)/i,
  },
  {
    id: 'clickfix_paste_shortcut',
    pattern: /(?:copy|copied).{0,120}(?:command|code|script).{0,180}(?:win(?:dows)?\s*(?:key)?\s*\+?\s*r|ctrl\s*\+?\s*v|paste|terminal|powershell|command prompt|cmd(?:\.exe)?|shell)/i,
  },
  {
    id: 'credential_exfiltration',
    pattern: /(?:copy|paste|send|upload|reveal|enter).{0,80}(?:password|passcode|secret|token|api\s*key|credential)/i,
  },
];

// ---------------------------------------------------------------------------
// Config (centralized env reads)
// ---------------------------------------------------------------------------
function captchaConfig(env = process.env) {
  return {
    provider: (env.GOLIATH_CAPTCHA_PROVIDER || '2captcha').trim().toLowerCase(),
    apiKey: (env.GOLIATH_CAPTCHA_KEY || '').trim(),
    siteKey: (env.GOLIATH_CAPTCHA_SITEKEY || '').trim(),
    ocrenabled: ['1', 'true', 'yes'].includes(String(env.GOLIATH_CAPTCHA_OCR || '').toLowerCase()),
    timeoutMs: parseInt(env.GOLIATH_CAPTCHA_TIMEOUT_MS || '120000', 10),
    // Optional HTTP proxy for solver API calls, e.g. "http://user:pass@host:port"
    proxy: (env.GOLIATH_CAPTCHA_PROXY || '').trim(),
  };
}

export async function resolveCaptchaConfig(pluginConfig = {}, env = process.env) {
  const base = captchaConfig(env);
  return {
    provider: (pluginConfig.provider || base.provider).trim().toLowerCase(),
    apiKey: (pluginConfig.apiKey || base.apiKey || '').trim(),
    siteKey: (pluginConfig.siteKey || base.siteKey || '').trim(),
    ocrenabled: pluginConfig.ocr !== undefined ? !!pluginConfig.ocr : base.ocrenabled,
    timeoutMs: parseInt(pluginConfig.timeoutMs || base.timeoutMs, 10),
    proxy: (pluginConfig.proxy || base.proxy || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the CAPTCHA on the page. Returns one of:
 *   { type: 'recaptcha-v2', siteKey, url, frame? }
 *   { type: 'hcaptcha', siteKey, url, frame? }
 *   { type: 'turnstile', siteKey, url, frame? }
 *   { type: 'text', answerInput, submitSelector, imageSelector?, url }
 *   null  -- nothing detected
 */
export async function detectCaptcha(page) {
  // Eval in page to find provider widgets.
  const found = await page.evaluate(() => {
    const loc = window.location.href;

    // reCAPTCHA
    const recaptcha = document.querySelector('.g-recaptcha') ||
      document.querySelector('[data-sitekey][class*="g-recaptcha"]') ||
      document.querySelector('[data-sitekey]');
    if (recaptcha) {
      const sk = recaptcha.getAttribute('data-sitekey');
      if (sk) return { kind: 'recaptcha-v2', siteKey: sk, url: loc };
    }

    // hCaptcha
    const hc = document.querySelector('.h-captcha') ||
      document.querySelector('[data-sitekey][class*="h-captcha"]');
    if (hc) {
      const sk = hc.getAttribute('data-sitekey');
      if (sk) return { kind: 'hcaptcha', siteKey: sk, url: loc };
    }

    // Cloudflare Turnstile
    const ts = document.querySelector('.cf-turnstile') ||
      document.querySelector('[data-sitekey][class*="turnstile"]');
    if (ts) {
      const sk = ts.getAttribute('data-sitekey');
      if (sk) return { kind: 'turnstile', siteKey: sk, url: loc };
    }

    // reCAPTCHA iframe fallback
    const rcFrame = document.querySelector('iframe[src*="recaptcha/api2"]');
    if (rcFrame) {
      const src = rcFrame.getAttribute('src') || '';
      const m = src.match(/[?&]k=([^&]+)/);
      return { kind: 'recaptcha-v2', siteKey: m ? m[1] : '', url: loc };
    }

    return null;
  });

  if (found) return found;

  // Text / image CAPTCHA: find an answer input + captcha image.
  const text = await page.evaluate(() => {
    const img = document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], img[class*="captcha" i], img[id*="captcha" i]');
    const input = document.querySelector('input[name*="captcha" i], input[id*="captcha" i], input[autocomplete*="captcha" i]');
    if (!img && !input) return null;
    return {
      loc: window.location.href,
      imageSelector: img ? buildSel(img) : null,
      inputSelector: input ? buildSel(input) : null,
    };
  });

  if (text) {
    return { type: 'text', url: text.loc, imageSelector: text.imageSelector, inputSelector: text.inputSelector };
  }

  return null;

  function buildSel(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    return el.tagName.toLowerCase();
  }
}

/**
 * Return a stable reason when a purported CAPTCHA contains ClickFix-style
 * instructions. This reads visible page text only; it never reads the
 * clipboard, executes page-supplied text, or invokes a local command runner.
 */
export async function detectSuspiciousCaptchaInstructions(page) {
  const text = await page.evaluate((maxChars) => String(document.body?.innerText || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .slice(0, maxChars), MAX_CAPTCHA_INSTRUCTION_CHARS);
  for (const rule of SUSPICIOUS_CAPTCHA_INSTRUCTION_RULES) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OCR (fallback for text CAPTCHAs)
// ---------------------------------------------------------------------------
function runOcr(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('tesseract', [imagePath, 'stdout', '--psm', '7'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`tesseract not available: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tesseract failed (${code}): ${err}`));
      const text = out.replace(/\s+/g, '').trim();
      resolve(text);
    });
  });
}

// ---------------------------------------------------------------------------
// Solver providers
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 5000;

async function postJson(url, body, proxy) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      ...(proxy ? { dispatcher: await proxyDispatcher(proxy) } : {}),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// Lazy proxy dispatcher — only invoked when a proxy is configured. Uses
// undici if Node's fetch does not natively support a proxy (Node >= 22 global
// fetch has no built-in proxy; undici's ProxyAgent supplies it).
async function proxyDispatcher(proxy) {
  const mod = await import('undici');
  return new mod.ProxyAgent({ uri: proxy });
}

function pollGet(url, proxy) {
  return new Promise((resolve, reject) => {
    (async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          ...(proxy ? { dispatcher: await proxyDispatcher(proxy) } : {}),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        resolve(data);
      } catch (e) { reject(e); } finally { clearTimeout(t); }
    })();
  });
}

async function solve2captcha(cfg, detected) {
  if (!cfg.apiKey) throw new Error('GOLIATH_CAPTCHA_KEY is required for the 2captcha provider');
  const base = 'https://2captcha.com';
  const task = {};
  if (detected.type === 'recaptcha-v2' || detected.kind === 'recaptcha-v2') {
    Object.assign(task, { type: 'NoCaptchaTaskProxyless', websiteURL: detected.url, websiteKey: detected.siteKey });
  } else if (detected.kind === 'hcaptcha' || detected.type === 'hcaptcha') {
    Object.assign(task, { type: 'HCaptchaTaskProxyless', websiteURL: detected.url, websiteKey: detected.siteKey });
  } else if (detected.kind === 'turnstile' || detected.type === 'turnstile') {
    Object.assign(task, { type: 'TurnstileTaskProxyless', websiteURL: detected.url, websiteKey: detected.siteKey });
  } else {
    throw new Error(`2captcha does not support challenge type "${detected.type || detected.kind}"`);
  }

  const create = await postJson(`${base}/in.php`, { key: cfg.apiKey, method: 'task', task, soft_id: 0 }, cfg.proxy);
  if (!create || !create.taskId) {
    throw new Error(`2captcha create failed: ${JSON.stringify(create)}`);
  }

  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await postJson(`${base}/res.php`, {
      key: cfg.apiKey,
      action: 'get',
      id: create.taskId,
    }, cfg.proxy);
    if (res && res.status === 1 && res.request) {
      return { token: res.request, solver: '2captcha' };
    }
    if (res && res.request && /CAPCHA_NOT_READY|not ready/i.test(res.request)) continue;
    if (res && res.request && /ERROR|FAILED|EXPIRED/i.test(res.request)) {
      throw new Error(`2captcha solve failed: ${res.request}`);
    }
  }
  throw new Error('2captcha solve timed out');
}

async function solveCapsolver(cfg, detected) {
  if (!cfg.apiKey) throw new Error('GOLIATH_CAPTCHA_KEY is required for the capsolver provider');
  const base = 'https://api.capsolver.com';
  let taskType;
  if (detected.type === 'recaptcha-v2' || detected.kind === 'recaptcha-v2') taskType = 'ReCaptchaV2TaskProxyLess';
  else if (detected.kind === 'hcaptcha' || detected.type === 'hcaptcha') taskType = 'HCaptchaTaskProxyLess';
  else if (detected.kind === 'turnstile' || detected.type === 'turnstile') taskType = 'ReCaptchaV2TaskProxyLess'; // Turnstile not natively supported
  else throw new Error(`capsolver does not support challenge type "${detected.type || detected.kind}"`);

  const create = await postJson(`${base}/createTask`, {
    clientKey: cfg.apiKey,
    task: {
      type: taskType,
      websiteURL: detected.url,
      websiteKey: detected.siteKey,
    },
  }, cfg.proxy);
  if (!create || !create.taskId) {
    throw new Error(`capsolver create failed: ${JSON.stringify(create)}`);
  }

  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await postJson(`${base}/getTaskResult`, {
      clientKey: cfg.apiKey,
      taskId: create.taskId,
    }, cfg.proxy);
    if (res && res.status === 'ready' && res.solution && (res.solution.gRecaptchaResponse || res.solution.token)) {
      return { token: res.solution.gRecaptchaResponse || res.solution.token, solver: 'capsolver' };
    }
    if (res && res.status === 'failed') {
      throw new Error(`capsolver solve failed: ${res.errorDescription || res.errorCode || 'unknown'}`);
    }
  }
  throw new Error('capsolver solve timed out');
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Solve a detected CAPTCHA.
 *   detected  -- result of detectCaptcha()
 * Returns { token, solver }. Throws on failure.
 */
export async function solveCaptcha(page, detected, cfg, ctx = {}) {
  const { log = () => {} } = ctx;
  const kind = detected.kind || detected.type;

  // If OCR-capable and it's a text/image captcha.
  if (kind === 'text') {
    if (!cfg.ocrenabled) {
      throw new Error('Text/image CAPTCHA detected but OCR is disabled (set GOLIATH_CAPTCHA_OCR=1)');
    }
    return { token: null, answer: await solveTextCaptcha(page, detected), solver: 'ocr' };
  }

  // Provider-based for recaptcha/hcaptcha/turnstile
  if (cfg.provider === 'capsolver') {
    const r = await solveCapsolver(cfg, detected);
    return r;
  }
  const r = await solve2captcha(cfg, detected);
  return r;
}

// Extract an image from the page, write to temp, OCR it, return answer text.
export async function solveTextCaptcha(page, detected) {
  if (!detected.imageSelector) {
    throw new Error('Text CAPTCHA detected but no image selector found');
  }
  if (!detected.inputSelector) {
    throw new Error('Text CAPTCHA detected but no answer input found');
  }
  const buffer = await page.evaluate((sel) => {
    const img = document.querySelector(sel);
    if (!img) return null;
    // If it's an <img> with a real src, fetch and b64 it.
    if (img.tagName === 'IMG' && img.src) {
      return img.src;
    }
    return null;
  }, detected.imageSelector);

  const tmp = path.join(os.tmpdir(), `goliath-captcha-${Date.now()}.png`);
  try {
    if (buffer && buffer.startsWith('data:')) {
      const b64 = buffer.split(',')[1];
      await fs.writeFile(tmp, Buffer.from(b64, 'base64'));
    } else if (buffer && /^https?:/i.test(buffer)) {
      const res = await fetch(buffer);
      const arr = await res.arrayBuffer();
      await fs.writeFile(tmp, Buffer.from(arr));
    } else {
      // Fall back to screenshotting the element region.
      const handle = await page.$(detected.imageSelector);
      if (!handle) throw new Error('could not locate captcha image element');
      await handle.screenshot({ path: tmp });
    }
    const answer = await runOcr(tmp);
    if (!answer) throw new Error('OCR returned empty result');
    return answer;
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

export { runOcr };

// Export helpers for tests
export const __internals = {
  postJson,
  solve2captcha,
  solveCapsolver,
  detectCaptcha,
  detectSuspiciousCaptchaInstructions,
};
