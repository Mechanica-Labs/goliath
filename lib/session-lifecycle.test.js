import {
  beginSessionActivity,
  endSessionActivity,
  removeSessionIfCurrent,
  sessionCanBeReaped,
  withSessionActivity,
} from './session-lifecycle.js';

test('active session operations block the reaper and refresh last access', async () => {
  const session = { lastAccess: 1, activeOperations: 0 };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const operation = withSessionActivity(session, async () => gate);

  expect(session.activeOperations).toBe(1);
  expect(sessionCanBeReaped(session)).toBe(false);
  release('done');
  await expect(operation).resolves.toBe('done');
  expect(session.activeOperations).toBe(0);
  expect(sessionCanBeReaped(session)).toBe(true);
});

test('session activity count is balanced and closing sessions remain ineligible', () => {
  const session = { lastAccess: 0 };
  beginSessionActivity(session, 10);
  beginSessionActivity(session, 20);
  endSessionActivity(session, 30);
  expect(session.activeOperations).toBe(1);
  endSessionActivity(session, 40);
  session._closing = true;
  expect(session.activeOperations).toBe(0);
  expect(session.lastAccess).toBe(40);
  expect(sessionCanBeReaped(session)).toBe(false);
});

test('closing an old session cannot delete its replacement', () => {
  const oldSession = { _closing: true };
  const replacement = { activeOperations: 1 };
  const sessions = new Map([['user', replacement]]);

  expect(removeSessionIfCurrent(sessions, 'user', oldSession)).toBe(false);
  expect(sessions.get('user')).toBe(replacement);
  expect(removeSessionIfCurrent(sessions, 'user', replacement)).toBe(true);
  expect(sessions.has('user')).toBe(false);
});
