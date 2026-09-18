import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

jest.unstable_mockModule('camoufox-js', () => ({ launchOptions: jest.fn(async () => ({})) }));
jest.unstable_mockModule('camoufox-js/dist/virtdisplay.js', () => ({ VirtualDisplay: class VirtualDisplay {} }));
jest.unstable_mockModule('impit', () => ({ Impit: class Impit {} }));

// Configured before server.js is imported so lib/config.js sees a fleet with a
// datacenter profile and a residential alternative.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goliath-antibot-routes-'));
process.env.GOLIATH_EGRESS_PROFILES = JSON.stringify([
  { name: 'dc-1', class: 'datacenter', server: 'dc.example.com:8000', username: 'u', password: 'p' },
  { name: 'res-1', class: 'residential', server: 'res.example.com:9000', country: 'AE' },
]);
process.env.GOLIATH_EGRESS_STATE_DIR = STATE_DIR;

const PX_SCRIPT = 'https://client.perimeterx.net/PXroute/main.min.js';
const SILENT_SAMPLE = { url: 'https://shop.example.com/login', scripts: [PX_SCRIPT], frames: [], globals: ['_pxAppId'], cookies: ['_pxhd'], interactive: 6, bodyText: 'Something went wrong. Please try again.' };
const CLEAN_SAMPLE = { url: 'https://shop.example.com/inbox', scripts: ['https://shop.example.com/app.js'], frames: [], globals: [], cookies: [], interactive: 14, bodyText: 'Inbox' };

let server;
let baseUrl;
let __testing;
let sample = CLEAN_SAMPLE;

function makeSession(tabId, { url = 'https://shop.example.com/inbox' } = {}) {
  const locator = {
    click: jest.fn(async () => {}),
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    first() { return locator; },
    nth() { return locator; },
    count: jest.fn(async () => 0),
    ariaSnapshot: jest.fn(async () => `- heading "Inbox"`),
    getAttribute: jest.fn(async () => null),
    scrollIntoViewIfNeeded: jest.fn(async () => {}),
    boundingBox: jest.fn(async () => ({ x: 1, y: 1, width: 20, height: 20 })),
    isVisible: jest.fn(async () => false),
    locator: jest.fn(() => ({ count: jest.fn(async () => 0), first() { return this; }, locator() { return this; } })),
  };
  const frame = { url: () => url, name: () => '', getByRole: () => locator, locator: () => locator, evaluate: jest.fn(async () => ({})) };
  const page = {
    url: () => url,
    mainFrame: () => frame,
    frames: () => [frame],
    getByRole: frame.getByRole,
    locator: frame.locator,
    isClosed: () => false,
    evaluate: jest.fn(async () => sample),
    keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
    mouse: { move: jest.fn(async () => {}), down: jest.fn(async () => {}), up: jest.fn(async () => {}), wheel: jest.fn(async () => {}) },
    waitForTimeout: jest.fn(async () => {}),
    waitForLoadState: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    removeAllListeners: jest.fn(),
    on: jest.fn(), off: jest.fn(),
  };
  const tabState = {
    page,
    refs: new Map([['e1', { role: 'button', name: 'Entrar', nth: 0, frameKey: 'main', frameUrl: url }]]),
    handoff: null,
    toolCalls: 0,
    consecutiveTimeouts: 0,
    consecutiveFailures: 0,
    lastSnapshot: null,
    visitedUrls: new Set(),
    behavior: { events: [] },
    semanticSnapshots: new Map(),
    lastSemanticSnapshot: null,
    semanticListeners: new Set(),
    actionContracts: new Map(),
    workflowSteps: [],
    wall: null,
  };
  const session = {
    context: { close: jest.fn(async () => {}), pages: () => [page] },
    tabGroups: new Map([['default', new Map([[tabId, tabState]])]]),
    secrets: new Map(),
    lastAccess: Date.now(),
    activeOperations: 0,
  };
  return { session, page, locator, tabState };
}

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

beforeAll(async () => {
  const serverModule = await import('../../server.js');
  ({ __testing } = serverModule);
  server = http.createServer(serverModule.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  __testing.sessions.clear();
  __testing.tabLocks.clear();
  __testing.setBrowser(null);
  sample = CLEAN_SAMPLE;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  delete process.env.GOLIATH_EGRESS_PROFILES;
  delete process.env.GOLIATH_EGRESS_STATE_DIR;
});

test('a clean page reports no wall', async () => {
  __testing.sessions.set('clean', makeSession('clean-tab').session);
  const result = await request('/tabs/clean-tab/wall?userId=clean');
  expect(result.status).toBe(200);
  expect(result.body.wall).toMatchObject({ state: 'none', blocking: false });
  expect(result.body.code).toBeUndefined();
  expect(result.body.egress).toEqual({ profile: 'dc-1', class: 'datacenter' });
});

test('a silently blocked page reports the vendor and the typed verdict', async () => {
  sample = SILENT_SAMPLE;
  __testing.sessions.set('wall', makeSession('wall-tab').session);
  const result = await request('/tabs/wall-tab/wall?userId=wall');
  expect(result.status).toBe(200);
  expect(result.body.code).toBe('perimeterx:blocked');
  expect(result.body.wall).toMatchObject({ vendor: 'perimeterx', state: 'silent', blocking: true, kind: 'silent-block', egressProfile: 'dc-1' });
});

test('a click swallowed by a wall returns the typed verdict on the click response', async () => {
  const fake = makeSession('click-tab');
  __testing.sessions.set('click', fake.session);
  sample = CLEAN_SAMPLE;
  // The page is clean before the click and walled after it, which is how
  // PerimeterX serves its interstitial on the action rather than on load.
  fake.page.evaluate = jest.fn(async () => (fake.locator.click.mock.calls.length ? SILENT_SAMPLE : CLEAN_SAMPLE));

  const result = await request('/tabs/click-tab/click', { method: 'POST', body: { userId: 'click', ref: 'e1' } });
  expect(result.status).toBe(200);
  expect(result.body.code).toBe('perimeterx:blocked');
  expect(result.body.wall).toMatchObject({ vendor: 'perimeterx', blocking: true, stage: 'click' });
});

test('wall/solve says not-applicable when there is no wall to drive', async () => {
  __testing.sessions.set('solve', makeSession('solve-tab').session);
  const result = await request('/tabs/solve-tab/wall/solve', { method: 'POST', body: { userId: 'solve' } });
  expect(result).toMatchObject({ status: 200, body: { outcome: 'not-applicable' } });
});

test('wall/solve returns the typed verdict when the wall cannot be driven', async () => {
  sample = SILENT_SAMPLE;
  __testing.sessions.set('solve2', makeSession('solve2-tab').session);
  const result = await request('/tabs/solve2-tab/wall/solve', { method: 'POST', body: { userId: 'solve2' } });
  expect(result.status).toBe(200);
  expect(result.body.code).toBe('perimeterx:blocked');
  expect(result.body.outcome).toBe('blocked');
  expect(result.body.wall).toMatchObject({ vendor: 'perimeterx', blocking: true });
});

test('repeated blocks mark the profile as a dead end and move the fleet on', async () => {
  sample = SILENT_SAMPLE;
  __testing.sessions.set('rotate', makeSession('rotate-tab').session);
  const activeBefore = (await request('/egress')).body.active;

  // Each failed solve records a block against the active profile and selects
  // the next one, so three rounds guarantee one profile is blocked twice.
  for (let attempt = 0; attempt < 3; attempt++) {
    const solve = await request('/tabs/rotate-tab/wall/solve', { method: 'POST', body: { userId: 'rotate' } });
    expect(solve.status).toBe(200);
    expect(solve.body.code).toBe('perimeterx:blocked');
  }

  const egress = await request('/egress');
  expect(egress.body.profiles.map(p => p.name)).toEqual(['dc-1', 'res-1']);
  expect(egress.body.active).not.toBe(activeBefore);
  expect(egress.body.matrix.some(row => (row.vendors.perimeterx?.blocked || 0) >= 2)).toBe(true);
  expect(egress.body.deadEnds.some(entry => entry.vendor === 'perimeterx')).toBe(true);
});

test('egress route lists profiles without credentials and reports the limits', async () => {
  const result = await request('/egress');
  expect(result.status).toBe(200);
  expect(result.body.profiles[0]).not.toHaveProperty('password');
  expect(result.body.limits).toMatchObject({ detectOnNavigation: true, driveChallenges: true, autoRotate: true });
  expect(Array.isArray(result.body.matrix)).toBe(true);
});
