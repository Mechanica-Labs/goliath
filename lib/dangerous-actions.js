/**
 * Dangerous-action brake for the fast-path interaction routes.
 *
 * The semantic contract flow (`/actions/plan` + `/actions/execute`) already
 * classifies risk and demands `confirm: true` for sensitive targets. The plain
 * `/click`, `/type`, and `/hands` routes had no equivalent: an agent could send
 * a message, place an order, or delete an account with a single unguarded call.
 *
 * This module owns the classification only. It is deliberately free of browser
 * and server imports so it stays trivially unit-testable (same pattern as
 * `lib/hands.js`). Route handlers in server.js resolve the target's accessible
 * name and call `classifyDangerousAction()`; when it returns a match and the
 * caller did not pass `confirm: true`, the route answers
 * `{ status: 'approval_required', ... }` instead of acting. The agent harness
 * then decides whether to ask a human and retry with `confirm: true`.
 *
 * Matching is keyword-based and intentionally conservative: it fires on the
 * control's visible/accessible name, on nearby buttons of a form-less composer
 * for Enter-key submits, and as a last fallback on the form-action path. It is a brake, not a policy engine, and it cannot
 * see intent; use the semantic contract flow when you need origin policies,
 * injection signals, and postconditions as well.
 */

export const DANGEROUS_ACTION_MODES = ['confirm', 'annotate', 'off'];
export const DEFAULT_DANGEROUS_ACTION_MODE = 'confirm';

/**
 * Ordered category table. Order matters: the first pattern that matches wins,
 * so the more specific credential-change patterns sit above the generic ones
 * ("Change password" must not classify as a plain "confirm"/"submit").
 *
 * Each pattern runs against a normalized, lower-cased label with collapsed
 * whitespace. Word boundaries keep "send" from matching "sendai" and
 * "post" from matching "postcode".
 */
const CATEGORIES = [
  {
    category: 'change_password',
    risk: 'credential_change',
    pattern: /\b(?:(?:change|reset|update|set|new)\s+(?:your\s+)?(?:password|passcode|pin)|change\s+(?:email|phone|2fa|two[- ]factor)|(?:enable|disable|remove)\s+(?:2fa|two[- ]factor|mfa))\b/,
  },
  {
    category: 'payment',
    risk: 'financial',
    pattern: /\b(?:pay(?:\s+now)?|make\s+(?:a\s+)?payment|complete\s+payment|checkout|check\s+out|place\s+(?:your\s+)?order|complete\s+(?:your\s+)?(?:order|purchase)|buy(?:\s+now)?|purchase|start\s+(?:free\s+)?trial)\b/,
  },
  {
    category: 'transfer',
    risk: 'financial',
    pattern: /\b(?:transfer(?:\s+(?:now|funds|money))?|withdraw(?:al)?|wire\s+(?:transfer|funds|money)|send\s+(?:money|funds|payment))\b/,
  },
  {
    category: 'sign',
    risk: 'legal_commitment',
    // "sign" but not sign in / sign-in / sign into / sign up / sign out / sign on / sign me in.
    pattern: /\b(?:e-?sign|sign(?!\s*-?\s*(?:in|into|up|out|on|me)\b)|signature|adopt\s+(?:and\s+)?sign|i\s+agree|accept\s+(?:and\s+)?(?:sign|agree)|agree\s+(?:and|&)\s+(?:continue|sign|submit))\b/,
  },
  {
    category: 'delete',
    risk: 'destructive',
    pattern: /\b(?:delete|erase|destroy|permanently\s+remove|remove\s+(?:account|member|user|card|payment\s+method)|close\s+(?:my\s+)?account|deactivate|cancel\s+(?:subscription|plan|membership|account|order)|revoke|wipe)\b/,
  },
  {
    category: 'send',
    risk: 'external_side_effect',
    pattern: /\b(?:send(?:\s+(?:message|email|mail|invite|invitation|request|now|it))?|submit\s+application)\b/,
  },
  {
    category: 'publish',
    risk: 'external_side_effect',
    pattern: /\b(?:publish|post(?:\s+(?:now|comment|reply|update))?|tweet|go\s+live)\b/,
  },
  {
    category: 'confirm',
    risk: 'irreversible_commit',
    pattern: /\b(?:confirm(?:\s+(?:order|purchase|payment|booking|reservation|changes?))?|approve|authorize|authorise|finalize|finalise|book\s+now|accept\s+(?:offer|terms)|yes,\s+(?:delete|remove|cancel|continue|proceed))\b/,
  },
];

export const DANGEROUS_ACTION_CATEGORIES = CATEGORIES.map(({ category, risk }) => ({ category, risk }));

const MAX_LABEL_CHARS = 512;
// Cyrillic/Greek lookalikes a hostile page could use to render "Send" that never matches /send/.
const HOMOGLYPHS = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h', '\u0501': 'd', '\u051b': 'q', '\u0433': 'r',
  '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u0442': 't', '\u0432': 'b', '\u043f': 'n',
  '\u03b1': 'a', '\u03b5': 'e', '\u03bf': 'o', '\u03c1': 'p', '\u03c5': 'u', '\u03bd': 'v', '\u03ba': 'k',
  '\u03b9': 'i', '\u03c4': 't', '\u03c7': 'x',
};
const MAX_CANDIDATES = 20;

/**
 * Normalize an accessible name / button label for matching.
 * Collapses whitespace, lower-cases, strips surrounding punctuation and emoji
 * noise so "Send →", "SEND", and "  send " all compare equal.
 */
export function normalizeActionLabel(value) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, MAX_LABEL_CHARS)
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase()
    .replace(/[\u0430-\u045f\u03b1-\u03c9]/g, ch => HOMOGLYPHS[ch] || ch)
    .replace(/[←-⇿☀-➿\u{1f300}-\u{1faff}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s,&'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a URL path into match-able words: "/account/change-password" ->
 * "account change password". Query strings and fragments are ignored; hosts
 * are never matched so "sendgrid.com" does not trip the "send" pattern.
 */
export function normalizeUrlPath(url) {
  if (typeof url !== 'string' || !url) return '';
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Relative form actions ("/checkout") are common; match on them directly.
    pathname = url.startsWith('/') ? url.split(/[?#]/)[0] : '';
  }
  return normalizeActionLabel(pathname.replace(/[/_.\-+]+/g, ' '))
    .split(' ')
    .map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .join(' ');
}

function hostnameOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

function matchCategory(label) {
  if (!label) return null;
  for (const entry of CATEGORIES) {
    const match = entry.pattern.exec(label);
    if (match) return { category: entry.category, risk: entry.risk, matched: match[0] };
  }
  return null;
}

const ACTION_LABELS = {
  click: 'Click',
  submit: 'Submit',
  type_submit: 'Type and submit',
  check: 'Check',
};

/**
 * Classify an interaction as dangerous or not.
 *
 * @param {object} input
 * @param {'click'|'submit'|'type_submit'|'check'} input.kind - what the route is about to do
 * @param {string} [input.element] - accessible name / visible label of the target control
 * @param {string[]} [input.candidates] - for submits without a form submit control: names of
 *   nearby buttons in the composer container (form-less chat UIs); the first dangerous one counts
 * @param {string} [input.role] - accessibility role of the target, when known
 * @param {string} [input.url] - current page URL (used for `domain` only)
 * @param {string} [input.formAction] - resolved form action URL for Enter-key submits; its
 *   path is a fallback when no control name matched (never the page URL: a plain Enter on
 *   /checkout is not itself dangerous)
 * @param {boolean} [input.unresolved] - the target's name could not be read (lookup error
 *   or timeout). A brake must fail closed, so this classifies as `unresolved_target`.
 * @returns {null|object} null when benign, otherwise an approval payload:
 *   `{ status: 'approval_required', action, kind, category, risk, element, domain, matched, source }`
 */
export function classifyDangerousAction({ kind = 'click', element, candidates, role, url, formAction, unresolved = false } = {}) {
  let hit = matchCategory(normalizeActionLabel(element));
  let source = 'element';
  let matchedElement = element;

  if (!hit && Array.isArray(candidates)) {
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      hit = matchCategory(normalizeActionLabel(candidate));
      if (hit) { source = 'nearby_control'; matchedElement = candidate; break; }
    }
  }
  if (!hit && (kind === 'submit' || kind === 'type_submit')) {
    hit = matchCategory(normalizeUrlPath(formAction));
    if (hit) source = 'form_action';
  }
  if (!hit && unresolved) {
    hit = { category: 'unresolved_target', risk: 'unknown', matched: null };
    source = 'lookup_failed';
    matchedElement = null;
  }
  if (!hit) return null;

  return {
    status: 'approval_required',
    action: ACTION_LABELS[kind] || kind,
    kind,
    category: hit.category,
    risk: hit.risk,
    element: typeof matchedElement === 'string' && matchedElement.trim() ? matchedElement.trim().slice(0, MAX_LABEL_CHARS) : null,
    role: typeof role === 'string' && role ? role : null,
    domain: hostnameOf(url),
    matched: hit.matched,
    source,
  };
}

/**
 * Parse the `GOLIATH_DANGEROUS_ACTIONS` setting.
 * - `confirm`  (default): refuse dangerous actions unless the request carries `confirm: true`
 * - `annotate`: perform the action but attach the classification to the response
 * - `off`     : never classify
 */
export function parseDangerousActionMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return DEFAULT_DANGEROUS_ACTION_MODE;
  if (DANGEROUS_ACTION_MODES.includes(normalized)) return normalized;
  if (['0', 'false', 'no', 'disabled'].includes(normalized)) return 'off';
  if (['1', 'true', 'yes', 'on', 'enabled', 'require', 'block'].includes(normalized)) return 'confirm';
  return DEFAULT_DANGEROUS_ACTION_MODE;
}

/**
 * Decide what a route should do for one interaction.
 *
 * @returns {{ decision: 'allow'|'approval_required'|'annotate', dangerous: object|null }}
 */
export function evaluateDangerousAction(input, { mode = DEFAULT_DANGEROUS_ACTION_MODE, confirm = false } = {}) {
  if (mode === 'off') return { decision: 'allow', dangerous: null };
  const dangerous = classifyDangerousAction(input);
  if (!dangerous) return { decision: 'allow', dangerous: null };
  if (mode === 'annotate' || confirm === true) return { decision: 'annotate', dangerous };
  return { decision: 'approval_required', dangerous };
}

/**
 * Build the HTTP response body for a refused action. Kept in one place so the
 * click, type, and hands routes return an identical shape.
 */
export function approvalRequiredResponse(dangerous, { hint } = {}) {
  return {
    ok: false,
    status: 'approval_required',
    action: dangerous.action,
    kind: dangerous.kind,
    category: dangerous.category,
    risk: dangerous.risk,
    element: dangerous.element,
    role: dangerous.role,
    domain: dangerous.domain,
    matched: dangerous.matched,
    source: dangerous.source,
    hint: hint || dangerous.hint || (dangerous.category === 'unresolved_target'
      ? 'The target control\'s name could not be read, so its effect is unknown. Take a snapshot to identify it, then retry with "confirm": true if it is safe.'
      : 'This action looks like it has an external or irreversible effect. Ask the user, then retry the same request with "confirm": true.'),
  };
}
