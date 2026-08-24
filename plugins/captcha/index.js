/**
 * Captcha plugin for goliath.
 *
 * Exposes `POST /tabs/:tabId/solve-captcha` which detects a CAPTCHA on the
 * current page, solves it (or marks it for human hand-off via the VNC plugin),
 * fills the answer/token, and submits — letting agents advance past anti-bot
 * walls such as Doordash, ticket sites, and login pages.
 *
 * Code separation: no `child_process`, no `process.env` reads in this file.
 * The solver logic lives in `captcha.js`.
 */

import { requireAuth } from '../../lib/auth.js';
import { checkSessionPolicy } from '../../lib/session-policy.js';
import {
  detectCaptcha,
  solveCaptcha,
  resolveCaptchaConfig,
} from './captcha.js';

const SET_SOLUTION_JS = (token) => `
  ((token) => {
    // reCAPTCHA v2: set the g-recaptcha-response textarea and signal callback.
    const ta = document.querySelector('#g-recaptcha-response');
    if (ta) {
      ta.value = token;
      // Dispatch change so any listener picks it up.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (window.__doPostback) return 'postback';
    }
    // hCaptcha uses its own iframe; token is applied via callback below.
    if (window.hcaptcha) return 'hcaptcha-api';
    return token ? 'set' : 'none';
  })(${JSON.stringify(token)})
`;

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, safeError } = ctx;

  const captchaCfg = await resolveCaptchaConfig(pluginConfig);

  // Determine enabled state: plugin config or env flag.
  const enabled = !!(
    pluginConfig.enabled === true ||
    pluginConfig.enabled === undefined &&
    ['1', 'true', 'yes'].includes(String(process.env.GOLIATH_CAPTCHA_ENABLED || '').toLowerCase())
  );

  if (!enabled) {
    log('info', 'captcha plugin: disabled (set GOLIATH_CAPTCHA_ENABLED=1 or plugins.captcha.enabled=true)');
    return;
  }

  const authMiddleware = requireAuth(config);

  /**
   * @openapi
   * /tabs/{tabId}/solve-captcha:
   *   post:
   *     tags: [Captcha]
   *     summary: Detect, solve, and submit a CAPTCHA on the current page
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
   *               siteKey:
   *                 type: string
   *                 description: Optional explicit reCAPTCHA/hCaptcha site-key override.
   *               submit:
   *                 type: boolean
   *                 description: Whether to click the submit/verify button after filling (default true).
   *     responses:
   *       200:
   *         description: Captcha solved and submitted.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 captchaType:
   *                   type: string
   *                 solver:
   *                   type: string
   *                 submitted:
   *                   type: boolean
   *                 url:
   *                   type: string
   *       404:
   *         description: Tab not found.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       422:
   *         description: Captcha could not be solved.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  app.post('/tabs/:tabId/solve-captcha', authMiddleware, async (req, res) => {
    const tabId = req.params.tabId;
    try {
      const { userId, siteKey, submit = true } = req.body || {};
      const session = sessions.get(String(userId));
      const found = session && findTab(session, tabId);
      if (!found) {
        return res.status(404).json({ error: `No active tab for tabId="${tabId}"` });
      }
      session.lastAccess = Date.now();
      const { tabState } = found;
      tabState.toolCalls++;
      tabState.consecutiveTimeouts = 0;
      tabState.consecutiveFailures = 0;

      // Respect the operator's session capability policy: solving a CAPTCHA
      // fills a form and submits it, so it must not bypass deny rules on
      // `submit`/`type` actions or origin restrictions.
      const page = tabState.page;
      const policyDecision = checkSessionPolicy(session?.policy || null, {
        action: 'submit',
        origin: page.url(),
        dangerousCategory: 'confirm',
      });
      if (!policyDecision.allowed) {
        return res.status(403).json({
          ok: false,
          error: 'Session policy denied this captcha solve',
          code: 'policy_violation',
          action: policyDecision.action,
          origin: policyDecision.origin,
          category: policyDecision.category,
          reason: policyDecision.reason,
        });
      }

      const cfg = { ...captchaCfg };
      if (siteKey) cfg.siteKey = siteKey;

      const detected = await detectCaptcha(page);
      if (!detected) {
        return res.status(422).json({ ok: false, error: 'No supported CAPTCHA detected on this page' });
      }

      log('info', 'captcha detected', { reqId: req.reqId, tabId, type: detected.kind || detected.type, url: detected.url });

      const solved = await solveCaptcha(page, detected, cfg, { log, events });

      // Fill + submit based on type.
      let submitted = false;
      if (solved.token) {
        // Provider token path
        submitted = await fillProviderToken(page, detected, solved.token);
      } else if (solved.answer) {
        // OCR text path
        submitted = await fillTextAnswer(page, detected, solved.answer);
      }
      if (submit && !submitted) {
        // Click the natural submit/verify button.
        submitted = await clickSubmit(page, detected);
      }

      events.emit('captcha:solved', { userId: String(userId), tabId, type: detected.kind || detected.type, solver: solved.solver, submitted });

      res.json({
        ok: true,
        captchaType: detected.kind || detected.type,
        solver: solved.solver,
        submitted: !!submitted,
        url: detected.url || page.url(),
      });
    } catch (err) {
      log('error', 'solve-captcha failed', { reqId: req.reqId, error: err.message });
      res.status(422).json({ ok: false, error: safeError(err) });
    }
  });

  log('info', 'captcha plugin: registered POST /tabs/:tabId/solve-captcha');

  // -------------------------------------------------------------------------

  async function fillProviderToken(page, detected, token) {
    const kind = detected.kind || detected.type;
    if (kind === 'recaptcha-v2') {
      // In a frameed reCAPTCHA, the checkbox click happens automatically once
      // the g-recaptcha-response is set and the callback fires. We set the
      // response and any associated hidden field.
      await page.evaluate(SET_SOLUTION_JS, token).catch(() => {});
      return true;
    }
    if (kind === 'hcaptcha') {
      await page.evaluate(SET_SOLUTION_JS, token).catch(() => {});
      return true;
    }
    if (kind === 'turnstile') {
      // Turnstile uses a token callback; set a synthetic input if present.
      await page.evaluate(SET_SOLUTION_JS, token).catch(() => {});
      return true;
    }
    return false;
  }

  async function fillTextAnswer(page, detected, answer) {
    const sel = detected.inputSelector;
    if (!sel) return false;
    const input = await page.$(sel);
    if (!input) return false;
    await input.fill(String(answer));
    return true;
  }

  async function clickSubmit(page, detected) {
    // Prefer an explicit captcha submit button; fall back to any visible submit.
    const selectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      '#submit',
      '.captcha-submit',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click().catch(() => {});
          return true;
        }
      }
    }
    return false;
  }
}

// findTab mirrors the core helper so the plugin does not depend on server.js internals.
function findTab(session, tabId) {
  if (!session || !session.tabGroups) return null;
  for (const group of session.tabGroups.values()) {
    if (group && group.has(tabId)) {
      return { tabState: group.get(tabId) };
    }
  }
  return null;
}
