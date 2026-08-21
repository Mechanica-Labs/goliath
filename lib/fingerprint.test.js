import vm from 'node:vm';
import { firefoxCoherenceScript } from './fingerprint.js';

function run(userAgent) {
  const context = { navigator: { userAgent }, chrome: { runtime: {} } };
  context.window = context;
  vm.runInNewContext(firefoxCoherenceScript(), context);
  return context;
}

test('Firefox coherence script removes a contradictory window.chrome surface', () => {
  const context = run('Mozilla/5.0 Firefox/141.0');
  expect('chrome' in context).toBe(false);
});
test('Firefox coherence script does not alter a Chromium user agent', () => {
  const context = run('Mozilla/5.0 Chrome/140.0 Safari/537.36');
  expect(context.chrome).toEqual({ runtime: {} });
});
