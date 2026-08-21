import { SessionReservationRegistry } from './session-reservations.js';

test('only one concurrent fork can reserve a target session', () => {
  const registry = new SessionReservationRegistry();
  const winner = registry.reserve('forked-user');
  const loser = registry.reserve('forked-user');
  expect(winner).toBeTruthy();
  expect(loser).toBeNull();
  expect(() => registry.assertAvailable('forked-user')).toThrow('reserved by a checkpoint fork');
  expect(registry.release('forked-user', Symbol('wrong'))).toBe(false);
  expect(registry.owns('forked-user', winner)).toBe(true);
  expect(registry.release('forked-user', winner)).toBe(true);
  expect(registry.reserve('forked-user')).toBeTruthy();
});

test('pre-existing or coalescing session creation cannot be reserved', () => {
  const registry = new SessionReservationRegistry();
  expect(registry.reserve('existing', { sessionExists: true })).toBeNull();
  expect(registry.reserve('creating', { creationPending: true })).toBeNull();
});
