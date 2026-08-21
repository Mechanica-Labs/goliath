import { jest } from '@jest/globals';
import { resolveRefTarget, targetFrameOrigin, validateSecretTarget } from './frame-targets.js';

function fakeFrame(url, label) {
  const locator = { label, nth: jest.fn(() => locator) };
  return {
    url: jest.fn(() => url.value),
    getByRole: jest.fn(() => locator),
    locator,
  };
}

test('identical controls resolve within their captured browsing contexts', () => {
  const mainUrl = { value: 'https://shop.example/checkout' };
  const oneUrl = { value: 'https://pay-one.example/form' };
  const twoUrl = { value: 'https://pay-two.example/form' };
  const main = fakeFrame(mainUrl, 'main');
  const one = fakeFrame(oneUrl, 'one');
  const two = fakeFrame(twoUrl, 'two');
  const page = { mainFrame: () => main, frames: () => [main, one, two] };
  const refs = new Map([
    ['e1', { role: 'button', name: 'Continue', nth: 0, frameKey: 'main', frameUrl: mainUrl.value, frame: main }],
    ['e2', { role: 'button', name: 'Continue', nth: 0, frameKey: 'frame-one', frameUrl: oneUrl.value, frame: one }],
    ['e3', { role: 'button', name: 'Continue', nth: 0, frameKey: 'frame-two', frameUrl: twoUrl.value, frame: two }],
  ]);

  expect(resolveRefTarget(page, 'e1', refs)).toMatchObject({ ok: true, frameKey: 'main', locator: main.locator });
  expect(resolveRefTarget(page, 'e2', refs)).toMatchObject({ ok: true, frameKey: 'frame-one', locator: one.locator });
  expect(resolveRefTarget(page, 'e3', refs)).toMatchObject({ ok: true, frameKey: 'frame-two', locator: two.locator });
});

test('secret checks use the live target frame and fail closed on navigation or opaque origins', () => {
  const mainUrl = { value: 'https://allowed.example/checkout' };
  const frameUrl = { value: 'https://evil.example/form' };
  const main = fakeFrame(mainUrl, 'main');
  const frame = fakeFrame(frameUrl, 'frame');
  const page = { mainFrame: () => main, frames: () => [main, frame] };
  const refs = new Map([['e1', {
    role: 'textbox', name: 'Password', nth: 0,
    frameKey: 'payment', frameUrl: frameUrl.value, frame,
  }]]);
  const secret = { allowedOrigins: ['https://allowed.example'] };

  const disallowed = resolveRefTarget(page, 'e1', refs);
  expect(targetFrameOrigin(disallowed)).toBe('https://evil.example');
  expect(validateSecretTarget(secret, disallowed)).toMatchObject({ ok: false, reason: 'target_frame_origin_not_allowed' });

  secret.allowedOrigins = ['https://evil.example'];
  expect(validateSecretTarget(secret, disallowed)).toEqual({ ok: true, origin: 'https://evil.example' });

  frameUrl.value = 'https://navigated.example/form';
  expect(resolveRefTarget(page, 'e1', refs)).toMatchObject({ ok: false, reason: 'frame_navigated' });

  frameUrl.value = 'about:srcdoc';
  refs.get('e1').frameUrl = 'about:srcdoc';
  const opaque = resolveRefTarget(page, 'e1', refs);
  expect(targetFrameOrigin(opaque)).toBeNull();
  expect(validateSecretTarget(secret, opaque)).toMatchObject({ ok: false, reason: 'target_frame_origin_unavailable' });
});
