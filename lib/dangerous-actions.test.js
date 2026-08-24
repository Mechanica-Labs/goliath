import { test, expect } from '@jest/globals';

import {
  DANGEROUS_ACTION_CATEGORIES,
  approvalRequiredResponse,
  classifyDangerousAction,
  evaluateDangerousAction,
  normalizeActionLabel,
  normalizeUrlPath,
  parseDangerousActionMode,
} from './dangerous-actions.js';

const LINKEDIN = 'https://www.linkedin.com/messaging/thread/abc/';

function category(element, kind = 'click', url = LINKEDIN) {
  return classifyDangerousAction({ kind, element, url })?.category ?? null;
}

test('classifies the advertised dangerous verbs', () => {
  expect(category('Send')).toBe('send');
  expect(category('Send message')).toBe('send');
  expect(category('Post')).toBe('publish');
  expect(category('Publish')).toBe('publish');
  expect(category('Delete')).toBe('delete');
  expect(category('Delete conversation')).toBe('delete');
  expect(category('Close my account')).toBe('delete');
  expect(category('Confirm')).toBe('confirm');
  expect(category('Confirm order')).toBe('confirm');
  expect(category('Transfer')).toBe('transfer');
  expect(category('Withdraw')).toBe('transfer');
  expect(category('Send money')).toBe('transfer');
  expect(category('Sign')).toBe('sign');
  expect(category('e-Sign')).toBe('sign');
  expect(category('Adopt and sign')).toBe('sign');
  expect(category('I agree')).toBe('sign');
  expect(category('Purchase')).toBe('payment');
  expect(category('Buy now')).toBe('payment');
  expect(category('Pay now')).toBe('payment');
  expect(category('Place order')).toBe('payment');
  expect(category('Change password')).toBe('change_password');
  expect(category('Reset your password')).toBe('change_password');
});

test('does not brake on benign chrome that shares a stem', () => {
  for (const label of [
    'Sign in', 'Sign-in', 'Sign into your account', 'Sign me in', 'Sign up', 'Sign out', 'Design', 'Signal', 'Résign',
    'Posts', 'Postcode', 'Messages', 'Search', 'Cancel', 'Close',
    'Accept all', 'Accept cookies', 'Payment methods', 'Edit address', 'Next',
    'Continue', 'Submit', 'Save', 'Sendai', 'Forward', 'Deposits', 'Swap', 'Reply', 'Apply now', 'Transfers',
    '', null, undefined,
  ]) {
    expect({ label, category: category(label) }).toEqual({ label, category: null });
  }
});

test('specific credential-change patterns win over generic verbs', () => {
  expect(category('Change password')).toBe('change_password');
  expect(category('Confirm new password')).toBe('change_password');
});

test('normalizes case, whitespace, and decoration', () => {
  expect(normalizeActionLabel('  SEND →  ')).toBe('send');
  expect(normalizeActionLabel('Delete 🗑️')).toBe('delete');
  expect(category('  SEND →  ')).toBe('send');
  expect(category('✓ Confirm')).toBe('confirm');
});

test('hostile relabelling with invisible characters or homoglyphs still matches', () => {
  expect(category('Se\u200Bnd')).toBe('send');          // zero-width space
  expect(category('Se\u00ADnd')).toBe('send');          // soft hyphen
  expect(category('S\u0435nd')).toBe('send');           // Cyrillic е
  expect(category('\u0455end')).toBe('send');           // Cyrillic ѕ
  expect(category('P\u0430y now')).toBe('payment');     // Cyrillic а
  expect(category('Dele\u0301te')).toBe('delete');      // combining acute
});

test('labels are bounded', () => {
  const huge = 'x'.repeat(10_000) + ' send';
  expect(normalizeActionLabel(huge).length).toBeLessThanOrEqual(512);
  expect(category(huge)).toBeNull();
  expect(category('send ' + 'x'.repeat(10_000))).toBe('send');
});

test('returns the approval payload shape with domain and matched keyword', () => {
  expect(classifyDangerousAction({ kind: 'click', element: 'Send', role: 'button', url: LINKEDIN })).toEqual({
    status: 'approval_required',
    action: 'Click',
    kind: 'click',
    category: 'send',
    risk: 'external_side_effect',
    element: 'Send',
    role: 'button',
    domain: 'www.linkedin.com',
    matched: 'send',
    source: 'element',
  });
});

test('form-action path fallback applies to submits only; the page URL never counts', () => {
  expect(normalizeUrlPath('https://bank.example/account/change-password?x=1#y')).toBe('account change password');
  expect(normalizeUrlPath('https://bank.example/transfers/new')).toBe('transfer new');
  expect(normalizeUrlPath('/checkout')).toBe('checkout');
  expect(normalizeUrlPath('not a url')).toBe('');

  expect(classifyDangerousAction({ kind: 'type_submit', element: 'Go', url: 'https://bank.example/app', formAction: 'https://bank.example/transfers/execute' }))
    .toMatchObject({ category: 'transfer', source: 'form_action', domain: 'bank.example', element: 'Go' });
  expect(classifyDangerousAction({ kind: 'submit', element: '', url: 'https://shop.example/cart', formAction: '/checkout' }))
    .toMatchObject({ category: 'payment', source: 'form_action' });

  // Enter in a search box on /checkout is not a purchase.
  expect(classifyDangerousAction({ kind: 'type_submit', element: 'Search', url: 'https://shop.example/checkout' })).toBeNull();
  // A plain click on a checkout page is not itself dangerous, and form actions do not apply to clicks.
  expect(classifyDangerousAction({ kind: 'click', element: 'Edit address', url: 'https://shop.example/checkout', formAction: '/checkout' })).toBeNull();
  // Hosts never match.
  expect(classifyDangerousAction({ kind: 'submit', element: '', url: 'https://app.sendgrid.com/login', formAction: 'https://app.sendgrid.com/login' })).toBeNull();
});

test('nearby controls of a form-less composer are considered for submits', () => {
  expect(classifyDangerousAction({ kind: 'type_submit', element: '', candidates: ['Emoji', 'Attach', 'Send'], url: 'https://www.linkedin.com/messaging/' }))
    .toMatchObject({ category: 'send', element: 'Send', source: 'nearby_control' });
  expect(classifyDangerousAction({ kind: 'type_submit', element: '', candidates: ['Bold', 'Italic'], url: 'https://x.example/' })).toBeNull();
});

test('an unreadable target fails closed', () => {
  expect(classifyDangerousAction({ kind: 'click', element: '', unresolved: true, url: 'https://x.example/' }))
    .toMatchObject({ category: 'unresolved_target', risk: 'unknown', source: 'lookup_failed', element: null, matched: null });
  expect(classifyDangerousAction({ kind: 'click', element: 'Send', unresolved: true, url: 'https://x.example/' }))
    .toMatchObject({ category: 'send', source: 'element' });
});

test('mode parsing defaults to confirm and tolerates boolean-ish values', () => {
  expect(parseDangerousActionMode(undefined)).toBe('confirm');
  expect(parseDangerousActionMode('')).toBe('confirm');
  expect(parseDangerousActionMode('confirm')).toBe('confirm');
  expect(parseDangerousActionMode('ANNOTATE')).toBe('annotate');
  expect(parseDangerousActionMode('off')).toBe('off');
  expect(parseDangerousActionMode('false')).toBe('off');
  expect(parseDangerousActionMode('0')).toBe('off');
  expect(parseDangerousActionMode('true')).toBe('confirm');
  expect(parseDangerousActionMode('garbage')).toBe('confirm');
});

test('evaluateDangerousAction honours mode and confirm', () => {
  const input = { kind: 'click', element: 'Send', url: LINKEDIN };
  expect(evaluateDangerousAction(input)).toMatchObject({ decision: 'approval_required' });
  expect(evaluateDangerousAction(input, { confirm: true })).toMatchObject({ decision: 'annotate' });
  expect(evaluateDangerousAction(input, { confirm: 'true' })).toMatchObject({ decision: 'approval_required' });
  expect(evaluateDangerousAction(input, { mode: 'annotate' })).toMatchObject({ decision: 'annotate' });
  expect(evaluateDangerousAction(input, { mode: 'off' })).toEqual({ decision: 'allow', dangerous: null });
  expect(evaluateDangerousAction({ kind: 'click', element: 'Next', url: LINKEDIN })).toEqual({ decision: 'allow', dangerous: null });
});

test('approvalRequiredResponse is a stable, documented shape', () => {
  const dangerous = classifyDangerousAction({ kind: 'click', element: 'Send', role: 'button', url: LINKEDIN });
  const body = approvalRequiredResponse(dangerous);
  expect(body).toMatchObject({
    ok: false,
    status: 'approval_required',
    action: 'Click',
    domain: 'www.linkedin.com',
    element: 'Send',
    risk: 'external_side_effect',
  });
  expect(typeof body.hint).toBe('string');
  expect(Object.keys(body).sort()).toEqual([
    'action', 'category', 'domain', 'element', 'hint', 'kind', 'matched', 'ok', 'risk', 'role', 'source', 'status',
  ]);
});

test('every category maps to exactly one risk label', () => {
  const categories = DANGEROUS_ACTION_CATEGORIES.map(entry => entry.category);
  expect(new Set(categories).size).toBe(categories.length);
  expect(categories).toEqual(['change_password', 'payment', 'transfer', 'sign', 'delete', 'send', 'publish', 'confirm']);
  expect(category('Send')).toBe('send');
  for (const entry of DANGEROUS_ACTION_CATEGORIES) expect(typeof entry.risk).toBe('string');
});
