/**
 * Hands — multi-step form automation primitives.
 *
 * A "Hand" is an ordered list of UI steps executed against a single tab in one
 * native request. This module owns validation only; the actual Playwright
 * execution lives in server.js. Keeping this file free of browser/server
 * imports keeps it trivially unit-testable and avoids circular imports.
 */

export class HandsError extends Error {
  constructor(message, stepIndex = null, details = {}) {
    super(message);
    this.name = 'HandsError';
    this.code = 'hands_error';
    this.stepIndex = stepIndex;
    this.details = details;
  }
}

const ACTIONS = ['click', 'type', 'select', 'check', 'wait', 'scroll', 'press', 'submit'];
// Caps are conservative on purpose: the global body parser accepts 100kb, so a
// single hand with many long `text` fields could 413 before this validation ever
// runs. Worst-case ASCII budget at these caps is ~60KB + JSON overhead, leaving
// headroom under the parser limit. Large forms should be split into multiple hands.
export const MAX_STEPS = 20;
const MAX_TEXT = 3000;
const MAX_WAIT_MS = 5000;

function hasTarget(step) {
  return (typeof step.ref === 'string' && step.ref.length > 0) ||
    (typeof step.selector === 'string' && step.selector.length > 0);
}

/**
 * Validate and normalize an ordered list of hand steps.
 *
 * @param {unknown} raw - raw steps array from the request body
 * @returns {Array<object>} normalized steps
 * @throws {HandsError} on the first invalid step
 */
export function coerceHandsSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HandsError('steps must be a non-empty array');
  }
  if (raw.length > MAX_STEPS) {
    throw new HandsError(`too many steps (max ${MAX_STEPS})`);
  }

  return raw.map((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new HandsError(`step ${i} must be an object`, i);
    }

    const action = step.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action)) {
      throw new HandsError(`step ${i}: unknown action "${action}" (valid: ${ACTIONS.join(', ')})`, i);
    }

    const out = { ...step, action };

    switch (action) {
      case 'click':
      case 'check':
        if (!hasTarget(step)) {
          throw new HandsError(`step ${i}: "${action}" requires ref or selector`, i);
        }
        break;

      case 'type': {
        if (typeof step.text !== 'string') {
          throw new HandsError(`step ${i}: "type" requires text`, i);
        }
        if (step.text.length > MAX_TEXT) {
          throw new HandsError(`step ${i}: text too long (max ${MAX_TEXT} chars)`, i);
        }
        const mode = step.mode || 'fill';
        if (mode !== 'fill' && mode !== 'keyboard') {
          throw new HandsError(`step ${i}: mode must be "fill" or "keyboard"`, i);
        }
        if (mode === 'fill' && !hasTarget(step)) {
          throw new HandsError(`step ${i}: "type" (mode=fill) requires ref or selector`, i);
        }
        out.mode = mode;
        break;
      }

      case 'select': {
        // Native <select> is excluded from accessibility refs (combobox), so a
        // CSS selector is the only reliable target. Require it up front so the
        // agent gets a clear contract error instead of a guaranteed stale-ref.
        if (typeof step.selector !== 'string' || step.selector.length === 0) {
          throw new HandsError(`step ${i}: "select" requires a CSS selector (native <select> is not exposed as an a11y ref)`, i);
        }
        const values = Array.isArray(step.values) ? step.values : (typeof step.value === 'string' ? [step.value] : null);
        if (!values || values.length === 0) {
          throw new HandsError(`step ${i}: "select" requires value or values`, i);
        }
        if (values.some(v => typeof v !== 'string')) {
          throw new HandsError(`step ${i}: "select" values must all be strings`, i);
        }
        out.values = values;
        break;
      }

      case 'wait': {
        const ms = Number(step.ms);
        out.ms = Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_WAIT_MS) : 300;
        break;
      }

      case 'scroll': {
        const direction = ['up', 'down', 'left', 'right'].includes(step.direction) ? step.direction : 'down';
        const amount = Number(step.amount);
        out.direction = direction;
        out.amount = Number.isFinite(amount) && amount > 0 ? amount : 500;
        break;
      }

      case 'press':
        if (typeof step.key !== 'string' || step.key.length === 0) {
          throw new HandsError(`step ${i}: "press" requires key`, i);
        }
        break;

      case 'submit':
        // Optional: press Enter by default, or click a specific control.
        break;

      default:
        break;
    }

    return out;
  });
}

// Humanized hand budget constants. A single humanized click on a live browser
// traverses a real pointer path + scroll-into-view + hesitation; observed cost
// is ~7-12s per click when elements are spread across the page (grid forms). A
// multi-click humanized hand therefore legitimately needs well beyond the flat
// non-humanized handler timeout — size the budget by step count × profile,
// bounded by a generous per-hand ceiling. Non-humanized (fast) hands keep the
// tight flat default.
const BUDGET_PER_STEP_MS = {
  deliberate: 15000,
  balanced: 12000,
  fast: 5000,
};
const MAX_HAND_BUDGET_MS = 120000;

/**
 * Compute the server-side time budget (ms) allowed for a single hands request.
 *
 * Pure, side-effect-free helper so the budget scaling is unit-testable without
 * any browser/server imports. Behavior must stay identical to the committed
 * fix in server.js.
 *
 * @param {object} opts
 * @param {string} opts.profile - 'deliberate' | 'balanced' | 'fast' (the humanized profile)
 * @param {number} opts.stepCount - number of steps in the hand
 * @param {boolean} opts.humanizedEnabled - true when humanized input is enabled
 * @param {number} [opts.handlerTimeoutMs] - flat default budget for non-humanized hands
 * @returns {number} budget in milliseconds
 */
export function computeHandBudgetMs({ profile, stepCount, humanizedEnabled, handlerTimeoutMs }) {
  if (!humanizedEnabled) return handlerTimeoutMs;
  const perStepBudgetMs = BUDGET_PER_STEP_MS[profile] ?? handlerTimeoutMs;
  return Math.min(perStepBudgetMs * stepCount, MAX_HAND_BUDGET_MS);
}
