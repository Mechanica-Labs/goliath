const DECISIONS = new Set(['allow', 'deny']);

export const SESSION_POLICY_ACTIONS = Object.freeze([
  'behavior',
  'check',
  'click',
  'close_tab',
  'create_tab',
  'downloads',
  'evaluate',
  'events',
  'extract',
  'handoff',
  'hover',
  'images',
  'links',
  'list_tabs',
  'navigate',
  'observe',
  'press',
  'screenshot',
  'scroll',
  'select',
  'semantic',
  'snapshot',
  'stats',
  'submit',
  'type',
  'upload',
  'viewport',
  'wait',
  'workflow',
]);

export const SESSION_POLICY_DANGEROUS_ACTIONS = Object.freeze([
  'change_password',
  'payment',
  'transfer',
  'sign',
  'delete',
  'send',
  'publish',
  'confirm',
  'unresolved_target',
]);

const ACTION_SET = new Set(SESSION_POLICY_ACTIONS);
const DANGEROUS_ACTION_SET = new Set(SESSION_POLICY_DANGEROUS_ACTIONS);
const MAX_ORIGIN_RULES = 100;

function policyError(message) {
  return Object.assign(new Error(message), { code: 'invalid_session_policy', statusCode: 400 });
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw policyError(`${field} must be an object`);
  }
}

function normalizeExactOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw policyError(`invalid origin rule: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
    throw policyError(`origin rules must use http or https: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw policyError(`origin rules cannot contain credentials, paths, queries, or fragments: ${value}`);
  }
  return parsed.origin;
}

function normalizeOriginRule(value) {
  if (typeof value !== 'string' || !value.trim()) throw policyError('origin rules must be non-empty strings');
  const candidate = value.trim();
  const wildcard = candidate.match(/^(https?):\/\/\*\.([^/?#]+)\/?$/i);
  if (!wildcard) return normalizeExactOrigin(candidate);

  const parsed = new URL(`${wildcard[1]}://wildcard.${wildcard[2]}`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw policyError(`wildcard origin rules cannot contain credentials, paths, queries, or fragments: ${value}`);
  }
  const baseHost = parsed.hostname.slice('wildcard.'.length);
  if (!baseHost || baseHost.includes('*') || baseHost === 'localhost') {
    throw policyError(`wildcards must target a DNS suffix: ${value}`);
  }
  return `${parsed.protocol}//*.${baseHost}${parsed.port ? `:${parsed.port}` : ''}`;
}

function normalizeOriginRules(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw policyError(`${field} must be an array`);
  if (value.length > MAX_ORIGIN_RULES) throw policyError(`${field} must contain at most ${MAX_ORIGIN_RULES} entries`);
  return [...new Set(value.map(normalizeOriginRule))];
}

function normalizeDecisionMap(value, field, allowedKeys) {
  if (value === undefined) return {};
  assertPlainObject(value, field);
  const normalized = {};
  for (const [key, decision] of Object.entries(value)) {
    if (!allowedKeys.has(key)) throw policyError(`${field} contains unsupported key: ${key}`);
    if (!DECISIONS.has(decision)) throw policyError(`${field}.${key} must be "allow" or "deny"`);
    normalized[key] = decision;
  }
  return normalized;
}

export function normalizeSessionPolicy(input) {
  assertPlainObject(input, 'policy');
  const allowedFields = new Set(['allowedOrigins', 'deniedOrigins', 'actions', 'dangerousActions']);
  const unknown = Object.keys(input).find(key => !allowedFields.has(key));
  if (unknown) throw policyError(`policy contains unsupported field: ${unknown}`);
  return Object.freeze({
    allowedOrigins: Object.freeze(normalizeOriginRules(input.allowedOrigins, 'allowedOrigins')),
    deniedOrigins: Object.freeze(normalizeOriginRules(input.deniedOrigins, 'deniedOrigins')),
    actions: Object.freeze(normalizeDecisionMap(input.actions, 'actions', ACTION_SET)),
    dangerousActions: Object.freeze(normalizeDecisionMap(input.dangerousActions, 'dangerousActions', DANGEROUS_ACTION_SET)),
  });
}

export function originFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function originMatchesRule(origin, rule) {
  const normalizedOrigin = originFromUrl(origin);
  if (!normalizedOrigin) return false;
  if (!rule.includes('://*.')) return normalizedOrigin === rule;

  const actual = new URL(normalizedOrigin);
  const wildcard = rule.match(/^(https?):\/\/\*\.([^:]+)(?::(\d+))?$/i);
  if (!wildcard) return false;
  const [, scheme, baseHost, port = ''] = wildcard;
  const actualPort = actual.port || '';
  return actual.protocol === `${scheme.toLowerCase()}:`
    && actualPort === port
    && actual.hostname !== baseHost
    && actual.hostname.endsWith(`.${baseHost}`);
}

function originDecision(policy, origin) {
  const hasOriginRules = policy.allowedOrigins.length > 0 || policy.deniedOrigins.length > 0;
  if (!hasOriginRules) return { allowed: true };
  const normalizedOrigin = originFromUrl(origin);
  if (!normalizedOrigin) return { allowed: false, reason: 'origin_unavailable', origin: null };
  if (policy.deniedOrigins.some(rule => originMatchesRule(normalizedOrigin, rule))) {
    return { allowed: false, reason: 'origin_denied', origin: normalizedOrigin };
  }
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.some(rule => originMatchesRule(normalizedOrigin, rule))) {
    return { allowed: false, reason: 'origin_not_allowed', origin: normalizedOrigin };
  }
  return { allowed: true, origin: normalizedOrigin };
}

export function checkSessionPolicy(policy, { action, origin, dangerousCategory, enforceOrigin = true } = {}) {
  if (!policy) return { allowed: true };
  if (action && policy.actions?.[action] === 'deny') {
    return { allowed: false, action, origin: originFromUrl(origin), category: 'action', reason: 'action_denied' };
  }
  if (dangerousCategory && policy.dangerousActions?.[dangerousCategory] === 'deny') {
    return {
      allowed: false,
      action,
      origin: originFromUrl(origin),
      category: dangerousCategory,
      reason: 'dangerous_action_denied',
    };
  }
  if (enforceOrigin) {
    const decision = originDecision(policy, origin);
    if (!decision.allowed) {
      return { allowed: false, action, origin: decision.origin, category: 'origin', reason: decision.reason };
    }
  }
  return { allowed: true, action, origin: originFromUrl(origin) };
}

export function sessionPolicyViolationError(decision) {
  const error = new Error('Session policy denied this action');
  error.code = 'policy_violation';
  error.statusCode = 403;
  error.action = decision.action || null;
  error.origin = decision.origin || null;
  error.category = decision.category || 'policy';
  error.reason = decision.reason || 'denied';
  return error;
}
