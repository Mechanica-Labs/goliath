import { humanizedClick, humanizedOptions, humanizedScroll, humanizedType, pointerTrajectory } from './humanized-input.js';

function mockPage() {
  const calls = { moves: [], wheel: [], keys: [], down: 0, up: 0 };
  return {
    calls,
    viewportSize: () => ({ width: 1000, height: 700 }),
    mouse: {
      move: async (x, y) => calls.moves.push({ x, y }),
      wheel: async (x, y) => calls.wheel.push({ x, y }),
      down: async () => { calls.down += 1; },
      up: async () => { calls.up += 1; },
    },
    keyboard: {
      type: async value => calls.keys.push(value),
    },
  };
}

test('humanizedOptions accepts booleans and bounded profiles', () => {
  expect(humanizedOptions(false).enabled).toBe(false);
  expect(humanizedOptions(true)).toEqual({ enabled: true, profile: 'balanced' });
  expect(humanizedOptions({ profile: 'fast' })).toEqual({ enabled: true, profile: 'fast' });
  expect(humanizedOptions({ profile: 'unknown' }).profile).toBe('balanced');
});
test('pointerTrajectory creates a curved multi-step path ending exactly at the target', () => {
  const points = pointerTrajectory({ x: 10, y: 20 }, { x: 500, y: 300 }, { random: () => 0.61 });
  expect(points.length).toBeGreaterThanOrEqual(12);
  expect(points.at(-1)).toEqual({ x: 500, y: 300 });
  expect(new Set(points.map(point => Math.round(point.y))).size).toBeGreaterThan(4);
});

test('humanizedClick emits real pointer movement and down/up events', async () => {
  const page = mockPage();
  const state = { pointer: { x: 20, y: 30 } };
  const events = [];
  const locator = { boundingBox: async () => ({ x: 400, y: 250, width: 120, height: 50 }) };
  const result = await humanizedClick(page, locator, state, {
    random: () => 0.5,
    sleep: async () => {},
    record: (type, detail) => events.push({ type, ...detail }),
  });

  expect(result.mode).toBe('humanized');
  expect(page.calls.moves.length).toBeGreaterThanOrEqual(12);
  expect(page.calls.down).toBe(1);
  expect(page.calls.up).toBe(1);
  expect(events.some(event => event.type === 'pointermove')).toBe(true);
  expect(events.some(event => event.type === 'pointerdown')).toBe(true);
});

test('humanizedType and humanizedScroll use variable event sequences', async () => {
  const page = mockPage();
  const delays = [];
  const events = [];
  const options = {
    random: () => 0.5,
    sleep: async delay => delays.push(delay),
    record: (type, detail) => events.push({ type, ...detail }),
  };

  const typed = await humanizedType(page, 'Hi, all', options);
  const scrolled = await humanizedScroll(page, 'down', 600, options);

  expect(typed.characters).toBe(7);
  expect(page.calls.keys.join('')).toBe('Hi, all');
  expect(delays).toHaveLength(7 + scrolled.pulses);
  expect(page.calls.wheel).toHaveLength(scrolled.pulses);
  expect(scrolled.pulses).toBeGreaterThanOrEqual(7);
  expect(events.filter(event => event.type === 'key')).toHaveLength(7);
  expect(events.filter(event => event.type === 'wheel')).toHaveLength(scrolled.pulses);
});
