import crypto from 'node:crypto';

const SENSITIVE_PATTERN = /\b(buy|checkout|pay|purchase|place order|delete|remove account|send|submit|publish|post|transfer|withdraw|confirm)\b/i;
const DESTRUCTIVE_PATTERN = /\b(delete|remove account|close account|transfer|withdraw|pay|purchase|place order)\b/i;
const SUPPORTED_ACTIONS = new Set(['click', 'type', 'type_secret', 'press']);
const POSTCONDITION_KINDS = new Set(['url_matches', 'node_exists', 'text_contains']);
const MAX_POSTCONDITIONS = 20;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function classifyActionRisk(action, node) {
  const description = `${action?.kind || ''} ${action?.intent || ''} ${node?.name || ''}`;
  if (DESTRUCTIVE_PATTERN.test(description)) return 'high';
  if (SENSITIVE_PATTERN.test(description) || action?.kind === 'type_secret') return 'medium';
  return 'low';
}

function planAction({ action, node, snapshot, policy = {}, now = Date.now() } = {}) {
  if (!action || typeof action !== 'object') throw new Error('action is required');
  if (!snapshot) throw new Error('snapshot is required');
  if (!node) throw new Error('target node not found');
  if (!SUPPORTED_ACTIONS.has(action.kind)) throw new Error(`unsupported action kind: ${action.kind || 'missing'}`);
  if (action.kind === 'type_secret' && !action.secretId) throw new Error('secretId is required for type_secret');

  const targetFrame = node.provenance?.frame || { key: 'main', url: snapshot.url };
  const origin = originOf(targetFrame.url);
  const allowedOrigins = Array.isArray(policy.allowedOrigins) ? policy.allowedOrigins : [];
  const originBlocked = allowedOrigins.length > 0 && !allowedOrigins.includes(origin);
  const highInjectionSignal = snapshot.security?.injectionSignals?.find(signal => signal.severity === 'high');
  const risk = classifyActionRisk(action, node);
  let decision = 'allow';
  const reasons = [];
  if (originBlocked) {
    decision = 'block';
    reasons.push('origin_not_allowed');
  } else if (highInjectionSignal && policy.allowPageInjectionSignals !== true) {
    decision = 'block';
    reasons.push('page_contains_prompt_injection_signal');
  } else if (risk === 'high' || (risk === 'medium' && policy.confirmSensitive !== false)) {
    decision = 'confirmation_required';
    reasons.push('sensitive_action');
  }
  if ((node.identityConfidence ?? 0) < (policy.minimumIdentityConfidence ?? 0.75)) {
    decision = 'block';
    reasons.push('identity_confidence_too_low');
  }
  if (!node.interactive) {
    decision = 'block';
    reasons.push('target_not_interactive');
  }

  return {
    contractId: `act_${crypto.randomUUID()}`,
    status: 'planned',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (policy.ttlMs || 5 * 60_000)).toISOString(),
    snapshotId: snapshot.snapshotId,
    target: {
      nodeId: node.id,
      ref: node.ref,
      role: node.role,
      name: node.name,
      frameKey: targetFrame.key,
      frameUrl: targetFrame.url,
    },
    action,
    risk,
    policy: { decision, reasons, origin },
    preconditions: [
      'snapshot_not_superseded', 'target_exists', 'target_identity_confident',
      ...(node.interactive ? ['target_interactive'] : []),
    ],
    predictedEffects: predictEffects(action, node),
  };
}

function predictEffects(action, node) {
  const effects = [];
  if (action.kind === 'click') effects.push(node.role === 'link' ? 'navigation' : 'page_state_change');
  if (action.kind === 'type' || action.kind === 'type_secret') effects.push('field_value_change');
  if (action.kind === 'press') effects.push(action.key === 'Enter' ? 'submission_or_navigation' : 'keyboard_state_change');
  if (classifyActionRisk(action, node) !== 'low') effects.push('possible_remote_side_effect');
  return effects;
}

function validateContract(contract, { snapshot, confirm = false, now = Date.now() } = {}) {
  if (!contract) return { ok: false, status: 'contract_not_found', reasons: ['contract_not_found'] };
  if (contract.status !== 'planned') return { ok: false, status: 'contract_consumed', reasons: ['contract_consumed'] };
  if (Date.parse(contract.expiresAt) < now) return { ok: false, status: 'contract_expired', reasons: ['contract_expired'] };
  if (!snapshot || snapshot.snapshotId !== contract.snapshotId) {
    return { ok: false, status: 'rejected_stale', reasons: ['snapshot_superseded'] };
  }
  const node = snapshot.nodes.find(item => item.id === contract.target.nodeId);
  if (!node) return { ok: false, status: 'rejected_stale', reasons: ['target_missing'] };
  if (contract.policy.decision === 'block') return { ok: false, status: 'blocked', reasons: contract.policy.reasons };
  if (contract.policy.decision === 'confirmation_required' && !confirm) {
    return { ok: false, status: 'confirmation_required', reasons: contract.policy.reasons };
  }
  return { ok: true, node };
}

function matchUrlPattern(pattern, url) {
  let expected = String(pattern || '');
  const actual = String(url || '');
  if (!expected || expected.length > 512) return false;
  const anchoredStart = expected.startsWith('^');
  const anchoredEnd = expected.endsWith('$');
  if (anchoredStart) expected = expected.slice(1);
  if (anchoredEnd) expected = expected.slice(0, -1);
  if (anchoredStart && anchoredEnd) return actual === expected;
  if (anchoredStart) return actual.startsWith(expected);
  if (anchoredEnd) return actual.endsWith(expected);
  return actual.includes(expected);
}

function nonEmptyString(value, maxLength = 512) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validatePostconditions(postconditions) {
  if (!Array.isArray(postconditions) || postconditions.length === 0) {
    return { ok: false, error: 'postconditions must be a non-empty array' };
  }
  if (postconditions.length > MAX_POSTCONDITIONS) {
    return { ok: false, error: `postconditions must contain at most ${MAX_POSTCONDITIONS} conditions` };
  }
  for (const [index, condition] of postconditions.entries()) {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      return { ok: false, error: `postconditions[${index}] must be an object` };
    }
    if (!POSTCONDITION_KINDS.has(condition.kind)) {
      return { ok: false, error: `postconditions[${index}].kind is unsupported` };
    }
    const allowedKeys = condition.kind === 'url_matches'
      ? new Set(['kind', 'pattern'])
      : condition.kind === 'text_contains'
        ? new Set(['kind', 'text'])
        : new Set(['kind', 'nodeId', 'name', 'role']);
    if (Object.keys(condition).some(key => !allowedKeys.has(key))) {
      return { ok: false, error: `postconditions[${index}] contains unknown fields` };
    }
    if (condition.kind === 'url_matches' && !nonEmptyString(condition.pattern)) {
      return { ok: false, error: `postconditions[${index}].pattern must be a non-empty string` };
    }
    if (condition.kind === 'text_contains' && !nonEmptyString(condition.text)) {
      return { ok: false, error: `postconditions[${index}].text must be a non-empty string` };
    }
    if (condition.kind === 'node_exists') {
      const fields = ['nodeId', 'name', 'role'].filter(key => condition[key] !== undefined);
      if (fields.length === 0 || fields.some(key => !nonEmptyString(condition[key], 256))) {
        return { ok: false, error: `postconditions[${index}] must provide non-empty nodeId, name, or role fields` };
      }
    }
  }
  return { ok: true };
}

function verifyPostconditions(postconditions, { url, snapshot } = {}) {
  const validation = validatePostconditions(postconditions);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.error), { statusCode: 400, code: 'invalid_postconditions' });
  }
  const results = postconditions.map(condition => {
    let passed = false;
    if (condition.kind === 'url_matches') {
      passed = matchUrlPattern(condition.pattern, url);
    } else if (condition.kind === 'node_exists') {
      passed = snapshot?.nodes?.some(node => ['nodeId', 'name', 'role'].every(field => {
        if (condition[field] === undefined) return true;
        const nodeField = field === 'nodeId' ? node.id : node[field];
        return nodeField === condition[field];
      })) || false;
    } else if (condition.kind === 'text_contains') {
      const needle = String(condition.text || '').toLowerCase();
      passed = snapshot?.nodes?.some(node => `${node.name || ''} ${node.value || ''}`.toLowerCase().includes(needle)) || false;
    }
    return { ...condition, passed };
  });
  return { verified: results.length > 0 && results.every(result => result.passed), results };
}

export { classifyActionRisk, matchUrlPattern, planAction, validateContract, validatePostconditions, verifyPostconditions };
