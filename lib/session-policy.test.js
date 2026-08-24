import { describe, expect, test } from '@jest/globals';
import {
  checkSessionPolicy,
  normalizeSessionPolicy,
  originMatchesRule,
  sessionPolicyViolationError,
} from './session-policy.js';

describe('session capability policy', () => {
  test('normalizes exact and scheme-pinned subdomain origins', () => {
    const policy = normalizeSessionPolicy({
      allowedOrigins: ['HTTPS://GitHub.com/', 'https://*.github.com'],
      deniedOrigins: ['https://billing.github.com'],
      actions: { evaluate: 'deny' },
      dangerousActions: { payment: 'deny' },
    });
    expect(policy.allowedOrigins).toEqual(['https://github.com', 'https://*.github.com']);
    expect(originMatchesRule('https://api.github.com/path', 'https://*.github.com')).toBe(true);
    expect(originMatchesRule('https://github.com', 'https://*.github.com')).toBe(false);
    expect(originMatchesRule('http://api.github.com', 'https://*.github.com')).toBe(false);
  });

  test('rejects paths, broad wildcards, unknown capabilities, and non-decisions', () => {
    expect(() => normalizeSessionPolicy({ allowedOrigins: ['https://example.com/path'] })).toThrow(/paths/);
    expect(() => normalizeSessionPolicy({ allowedOrigins: ['https://*.localhost'] })).toThrow(/DNS suffix/);
    expect(() => normalizeSessionPolicy({ actions: { typo: 'deny' } })).toThrow(/unsupported key/);
    expect(() => normalizeSessionPolicy({ actions: { click: false } })).toThrow(/allow.*deny/);
    expect(() => normalizeSessionPolicy({ surprise: true })).toThrow(/unsupported field/);
  });

  test('is allow-by-default and denied origins take precedence', () => {
    const policy = normalizeSessionPolicy({
      allowedOrigins: ['https://*.example.com'],
      deniedOrigins: ['https://admin.example.com'],
    });
    expect(checkSessionPolicy(null, { action: 'click', origin: 'about:blank' }).allowed).toBe(true);
    expect(checkSessionPolicy(policy, { action: 'click', origin: 'https://shop.example.com' }).allowed).toBe(true);
    expect(checkSessionPolicy(policy, { action: 'click', origin: 'https://admin.example.com' })).toMatchObject({
      allowed: false, reason: 'origin_denied', category: 'origin',
    });
    expect(checkSessionPolicy(policy, { action: 'click', origin: 'about:blank' })).toMatchObject({
      allowed: false, reason: 'origin_unavailable', origin: null,
    });
  });

  test('hard-denies capabilities and dangerous categories independently of confirmation', () => {
    const policy = normalizeSessionPolicy({
      actions: { upload: 'deny' },
      dangerousActions: { transfer: 'deny' },
    });
    expect(checkSessionPolicy(policy, { action: 'upload', origin: 'https://example.com' })).toMatchObject({
      allowed: false, category: 'action', reason: 'action_denied',
    });
    const dangerous = checkSessionPolicy(policy, {
      action: 'click', origin: 'https://bank.example', dangerousCategory: 'transfer',
    });
    expect(dangerous).toMatchObject({ allowed: false, category: 'transfer', reason: 'dangerous_action_denied' });
    expect(sessionPolicyViolationError(dangerous)).toMatchObject({
      code: 'policy_violation', statusCode: 403, action: 'click', category: 'transfer',
    });
  });

  test('can check action policy without applying origin scope to cleanup operations', () => {
    const policy = normalizeSessionPolicy({ allowedOrigins: ['https://example.com'] });
    expect(checkSessionPolicy(policy, { action: 'close_tab', origin: null, enforceOrigin: false }).allowed).toBe(true);
  });
});
