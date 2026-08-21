import { expect, test } from '@jest/globals';

import { createFlyHelpers } from '../../lib/fly.js';
import { expandMacro, getSupportedMacros } from '../../lib/macros.js';

test('Fly tab ownership rejects non-string request parameter shapes', () => {
  const fly = createFlyHelpers({ flyMachineId: 'abcdef12345678' });
  expect(fly.parseTabOwner(['abcdef12345678_tab'])).toBeNull();
  expect(fly.parseTabOwner({ value: 'abcdef12345678_tab' })).toBeNull();
  expect(fly.parseTabOwner('fedcba87654321_tab')).toBe('fedcba87654321');
});

test('search macro dispatch accepts only declared literal macros', () => {
  expect(expandMacro('@google_search', 'quoted & query')).toBe('https://www.google.com/search?q=quoted%20%26%20query');
  expect(expandMacro('constructor', 'ignored')).toBeNull();
  expect(expandMacro('__proto__', 'ignored')).toBeNull();
  expect(getSupportedMacros()).toContain('@reddit_subreddit');
});
