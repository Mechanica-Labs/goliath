import { expect, test } from '@jest/globals';

import {
  detectWall,
  driveChallenge,
  meaningfulRequests,
  observeRequests,
  wallError,
  wallIsBlocking,
  wallSummary,
} from '../../lib/antibot.js';
import { startAntibotFixture } from '../fixtures/antibot-fixture.js';

const PX_FRAME = 'https://geo.captcha-delivery.com/captcha/?initialCid=x';
const PX_SCRIPT = 'https://client.perimeterx.net/PXabc/main.min.js';

function fakePage(sample, { requests = [], frames = [], emitter = true } = {}) {
  const listeners = new Map();
  const page = {
    evaluate: async () => (typeof sample === 'function' ? sample() : sample),
    frames: () => frames,
    mainFrame: () => frames[0] || {},
    waitForTimeout: async () => {},
  };
  if (emitter) {
    page.on = (event, fn) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    };
    page.off = (event, fn) => {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter(f => f !== fn));
    };
    page.emit = (event, value) => (listeners.get(event) || []).forEach(fn => fn(value));
    page.pending = requests;
  }
  return page;
}

function challengeSample() {
  return { url: 'https://shop.example.com/login', scripts: [PX_SCRIPT], frames: [PX_FRAME], globals: ['_pxAppId', '_pxChallenge'], cookies: ['_pxhd'], interactive: 4, bodyText: 'Verify you are human' };
}

function silentSample() {
  return { url: 'https://shop.example.com/login', scripts: [PX_SCRIPT], frames: [], globals: ['_pxAppId', '_pxhd'], cookies: ['_pxhd'], interactive: 6, bodyText: 'Entrar Something went wrong. Please try again.' };
}

test('detects a visible PerimeterX challenge from its frame', async () => {
  const wall = await detectWall(fakePage(challengeSample()));
  expect(wall.vendor).toBe('perimeterx');
  expect(wall.state).toBe('challenge');
  expect(wall.challengeFrame).toBe(PX_FRAME);
  expect(wallIsBlocking(wall)).toBe(true);
});

test('classifies a silent block when the vendor marks the page but no challenge is shown', async () => {
  const response = { status: () => 403 };
  const wall = await detectWall(fakePage(silentSample()), { response });
  expect(wall.vendor).toBe('perimeterx');
  expect(wall.state).toBe('silent');
  expect(wallIsBlocking(wall)).toBe(true);
  expect(wallSummary(wall)).toMatchObject({ vendor: 'perimeterx', state: 'silent', blocking: true });
});

test('treats a press-and-hold interstitial in the main document as a drivable challenge', async () => {
  // Observed live on zillow.com: 403, no challenge frame, PerimeterX globals,
  // zero interactive elements, and this copy in the document body.
  const wall = await detectWall(fakePage({
    url: 'https://www.zillow.com/',
    scripts: ['https://client.px-cloud.net/PXHYx10rg3/main.min.js'],
    frames: [],
    globals: ['_pxAppId', '_pxVid', '_pxUuid'],
    cookies: ['_pxvid', '_px3'],
    interactive: 0,
    bodyText: 'Press & Hold to confirm you are a human (and not a bot). Reference ID e8da5cd1',
  }), { response: { status: () => 403 } });
  expect(wall.vendor).toBe('perimeterx');
  expect(wall.state).toBe('challenge');
  expect(wall.kind).toBe('press-hold');
  expect(wallIsBlocking(wall)).toBe(true);
});

test('classifies a silent block from block copy even with a 200 response', async () => {
  const wall = await detectWall(fakePage({ ...silentSample(), interactive: 0 }));
  expect(wall.state).toBe('silent');
});

test('an ordinary tagged page is clear, not blocking', async () => {
  const wall = await detectWall(fakePage({ ...silentSample(), bodyText: 'Welcome back' }));
  expect(wall.vendor).toBe('perimeterx');
  expect(wall.state).toBe('clear');
  expect(wallIsBlocking(wall)).toBe(false);
});

test('a page without vendor markers reports none', async () => {
  const wall = await detectWall(fakePage({ url: 'https://example.com', scripts: ['https://example.com/app.js'], frames: [], globals: [], cookies: [], interactive: 12, bodyText: 'Hello' }));
  expect(wall.vendor).toBeNull();
  expect(wall.state).toBe('none');
});

test('degrades to a none verdict when the page cannot be read', async () => {
  const wall = await detectWall(fakePage(() => { throw new Error('execution context destroyed'); }));
  expect(wall.state).toBe('none');
  expect(wall.error).toBeDefined();
});

test('the typed verdict names the vendor and refuses blind retries', () => {
  const error = wallError({ vendor: 'perimeterx', state: 'silent' }, { egressClass: 'datacenter', triedProfiles: ['dc-1'], attempts: 2, url: 'https://shop.example.com/login' });
  expect(error.code).toBe('perimeterx:blocked');
  expect(error.statusCode).toBe(403);
  expect(error.retrySafe).toBe(false);
  expect(error.egressClass).toBe('datacenter');
  expect(error.triedProfiles).toEqual(['dc-1']);
});

test('observeRequests reports only meaningful requests', async () => {
  const page = fakePage(challengeSample());
  const requests = [
    { method: () => 'GET', url: () => 'https://cdn.example.com/logo.png', resourceType: () => 'image' },
    { method: () => 'GET', url: () => 'https://geolocation.onetrust.com/px.gif?x=1', resourceType: () => 'image' },
    { method: () => 'POST', url: () => 'https://shop.example.com/api/login', resourceType: () => 'fetch' },
  ];
  const seen = await observeRequests(page, async () => {
    for (const request of requests) page.emit('request', request);
  });
  expect(seen).toHaveLength(3);
  expect(meaningfulRequests(seen)).toEqual([requests[2]].map(r => ({ method: 'POST', url: 'https://shop.example.com/api/login', resourceType: 'fetch' })));
});

test('driveChallenge is not attempted when no challenge is visible', async () => {
  const result = await driveChallenge(fakePage(silentSample()), { vendor: 'perimeterx', state: 'silent' }, {});
  expect(result).toMatchObject({ attempted: false, outcome: 'not-applicable' });
});

test('driveChallenge drives the visible challenge through native input and reports cleared', async () => {
  const page = fakePage(() => (page.pressed ? { ...challengeSample(), scripts: [], frames: [], cookies: [], globals: [], bodyText: 'Welcome back' } : challengeSample()), {
    frames: [{ url: () => PX_FRAME, locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true }) }) }],
  });
  const state = { pointer: null };
  const calls = [];
  const result = await driveChallenge(page, { vendor: 'perimeterx', state: 'challenge', challengeFrame: PX_FRAME }, {
    humanizedClick: async () => calls.push('click'),
    humanizedPressAndHold: async (_page, _locator, _state, options) => { page.pressed = true; calls.push(`hold:${options.holdMs}`); },
    state,
  });
  expect(calls).toEqual(['hold:4200']);
  expect(result.attempted).toBe(true);
  expect(result.outcome).toBe('cleared');
  expect(result.selector).toContain('input[type=checkbox]');
});

test('falls back to a real press-and-hold on the challenge frame centre', async () => {
  // Observed live on zillow.com: the PerimeterX challenge frame exposes no
  // addressable control, so the frame box itself is the press target.
  const page = fakePage(() => (page.pressed
    ? { ...challengeSample(), scripts: [], frames: [], cookies: [], globals: [], bodyText: 'Welcome back' }
    : challengeSample()), {
    frames: [{ url: () => PX_FRAME, locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }) }],
  });
  page.locator = () => ({ first: () => ({ count: async () => 1, boundingBox: async () => ({ x: 100, y: 200, width: 300, height: 120 }) }) });
  const calls = [];
  const result = await driveChallenge(page, { vendor: 'perimeterx', state: 'challenge', challengeFrame: PX_FRAME }, {
    humanizedClick: async () => calls.push('click'),
    humanizedPressAndHold: async (_page, _locator, _state, options) => { page.pressed = true; calls.push({ hold: options.holdMs, strictHitTarget: options.strictHitTarget }); },
    state: {},
  });
  expect(calls).toEqual([{ hold: 4200, strictHitTarget: false }]);
  expect(result.outcome).toBe('cleared');
  expect(result.selector).toContain('coordinate:center');
});

test('driveChallenge reports a challenge that survives native input', async () => {
  const page = fakePage(challengeSample(), {
    frames: [{ url: () => PX_FRAME, locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true }) }) }],
  });
  const result = await driveChallenge(page, { vendor: 'perimeterx', state: 'challenge', challengeFrame: PX_FRAME }, {
    humanizedClick: async () => {},
    state: {},
  });
  expect(result.outcome).toBe('still-challenging');
});

test('the repro fixture carries the markers detection relies on', async () => {
  const fixture = await startAntibotFixture();
  try {
    const challenge = await fetch(`${fixture.url}/px-challenge`).then(r => r.text());
    expect(challenge).toContain('geo.captcha-delivery.com');
    expect(challenge).toContain(`window._pxAppId='${fixture.appId}'`);
    const silent = await fetch(`${fixture.url}/px-silent`);
    expect(silent.status).toBe(403);
    expect(silent.headers.get('x-px')).toBe('1');
    const silentBody = await silent.text();
    const wall = await detectWall(fakePage({ url: `${fixture.url}/px-silent`, scripts: [PX_SCRIPT], frames: [], globals: ['_pxAppId'], cookies: [], interactive: 6, bodyText: silentBody.replace(/<[^>]+>/g, ' ') }), { response: { status: () => 403 } });
    expect(wall.state).toBe('silent');
    const clean = await detectWall(fakePage({ url: `${fixture.url}/clean`, scripts: [], frames: [], globals: [], cookies: [], interactive: 8, bodyText: 'Fixture inbox' }));
    expect(clean.state).toBe('none');
  } finally {
    await fixture.close();
  }
});
