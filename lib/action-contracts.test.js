import { planAction, validateContract, verifyPostconditions } from './action-contracts.js';

const node = { id: 'sem_buy', ref: 'e1', role: 'button', name: 'Place order', interactive: true, identityConfidence: 0.95 };
const snapshot = { snapshotId: 'snap_1', url: 'https://shop.example/checkout', nodes: [node] };

test('sensitive action plans require confirmation', () => {
  const contract = planAction({ action: { kind: 'click' }, node, snapshot, now: 0 });
  expect(contract.risk).toBe('high');
  expect(contract.policy.decision).toBe('confirmation_required');
  expect(validateContract(contract, { snapshot, now: 1 }).status).toBe('confirmation_required');
  expect(validateContract(contract, { snapshot, confirm: true, now: 1 }).ok).toBe(true);
});

test('contracts fail closed when snapshots change', () => {
  const contract = planAction({ action: { kind: 'click' }, node, snapshot });
  const result = validateContract(contract, { snapshot: { ...snapshot, snapshotId: 'snap_2' }, confirm: true });
  expect(result).toMatchObject({ ok: false, status: 'rejected_stale' });
});

test('contracts are single use', () => {
  const contract = planAction({ action: { kind: 'click' }, node, snapshot });
  contract.status = 'executing';
  expect(validateContract(contract, { snapshot, confirm: true })).toMatchObject({ ok: false, status: 'contract_consumed' });
});

test('policy blocks disallowed origins and uncertain identities', () => {
  const contract = planAction({
    action: { kind: 'click' },
    node: { ...node, name: 'Continue', identityConfidence: 0.6 },
    snapshot,
    policy: { allowedOrigins: ['https://allowed.example'] },
  });
  expect(contract.policy.decision).toBe('block');
  expect(contract.policy.reasons).toEqual(expect.arrayContaining(['origin_not_allowed', 'identity_confidence_too_low']));
});

test('policy blocks actions when a page has a high-severity injection signal', () => {
  const contract = planAction({
    action: { kind: 'click' },
    node: { ...node, name: 'Continue' },
    snapshot: {
      ...snapshot,
      security: { injectionSignals: [{ nodeId: 'sem_other', severity: 'high' }] },
    },
  });
  expect(contract.policy.decision).toBe('block');
  expect(contract.policy.reasons).toContain('page_contains_prompt_injection_signal');
});

test('secret typing requires an opaque secret identifier', () => {
  expect(() => planAction({
    action: { kind: 'type_secret' },
    node,
    snapshot,
  })).toThrow('secretId is required');
});

test('postconditions report evidence instead of assuming success', () => {
  const verification = verifyPostconditions([
    { kind: 'url_matches', pattern: '/receipt$' },
    { kind: 'text_contains', text: 'confirmed' },
  ], {
    url: 'https://shop.example/receipt',
    snapshot: { nodes: [{ name: 'Order confirmed' }] },
  });
  expect(verification.verified).toBe(true);
});

test('URL postconditions use bounded literal matching instead of evaluating regular expressions', () => {
  expect(verifyPostconditions([
    { kind: 'url_matches', pattern: '(a+)+$' },
  ], { url: `https://example.com/${'a'.repeat(10_000)}!` })).toMatchObject({ verified: false });
  expect(verifyPostconditions([
    { kind: 'url_matches', pattern: '^https://shop.example/receipt$' },
  ], { url: 'https://shop.example/receipt' })).toMatchObject({ verified: true });
});
