import http from 'node:http';
import fs from 'node:fs/promises';
import { jest } from '@jest/globals';

jest.unstable_mockModule('camoufox-js', () => ({ launchOptions: jest.fn(async () => ({})) }));
jest.unstable_mockModule('camoufox-js/dist/virtdisplay.js', () => ({ VirtualDisplay: class VirtualDisplay {} }));
jest.unstable_mockModule('impit', () => ({ Impit: class Impit {} }));

let server;
let baseUrl;
let app;
let __testing;

function makeSession(tabId = 'tab-route-test') {
  const page = {
    evaluate: jest.fn(async expression => `evaluated:${expression}`),
    locator: jest.fn(),
    isClosed: () => false,
  };
  const tabState = {
    page,
    handoff: null,
    toolCalls: 0,
    consecutiveTimeouts: 0,
    consecutiveFailures: 0,
    lastSemanticSnapshot: null,
    actionContracts: new Map(),
  };
  const session = {
    context: { close: jest.fn(async () => {}), pages: () => [page] },
    tabGroups: new Map([['default', new Map([[tabId, tabState]])]]),
    secrets: new Map(),
    downloads: [],
    lastAccess: Date.now(),
    activeOperations: 0,
  };
  return { session, tabState, page };
}

function makeSemanticIframeSession(tabId = 'iframe-tab') {
  const mainUrl = { value: 'https://allowed.example/checkout' };
  const childUrl = { value: 'https://evil.example/form' };
  const fills = [];
  const makeLocator = (yaml, frameLabel) => ({
    ariaSnapshot: jest.fn(async () => yaml),
    nth: jest.fn(function nth() { return this; }),
    fill: jest.fn(async value => { fills.push({ frameLabel, value }); }),
    click: jest.fn(async () => {}),
    press: jest.fn(async () => {}),
  });
  const mainBody = makeLocator('- main "Checkout":\n  - button "Continue"', 'main');
  const childBody = makeLocator('- form "Payment":\n  - textbox "Password"', 'child');
  const mainFrame = {
    url: () => mainUrl.value,
    name: () => '',
    locator: () => mainBody,
    getByRole: () => mainBody,
  };
  const childFrame = {
    url: () => childUrl.value,
    name: () => 'payment-frame',
    locator: () => childBody,
    getByRole: () => childBody,
  };
  const hidden = { first: () => hidden, isVisible: async () => false };
  const page = {
    url: () => mainUrl.value,
    isClosed: () => false,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, childFrame],
    locator: () => hidden,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  const tabState = {
    page,
    refs: new Map(),
    handoff: null,
    toolCalls: 0,
    consecutiveTimeouts: 0,
    consecutiveFailures: 0,
    lastSnapshot: null,
    semanticSnapshots: new Map(),
    lastSemanticSnapshot: null,
    semanticListeners: new Set(),
    actionContracts: new Map(),
    workflowSteps: [],
    readinessTracker: { sample: async () => ({ ready: true, score: 1, signals: {}, reasons: [], retryAfterMs: 0 }) },
  };
  const session = {
    context: { close: jest.fn(async () => {}), pages: () => [page] },
    tabGroups: new Map([['default', new Map([[tabId, tabState]])]]),
    secrets: new Map(),
    lastAccess: Date.now(),
    activeOperations: 0,
  };
  return { session, tabState, mainUrl, childUrl, fills };
}

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  ({ app, __testing } = await import('../../server.js'));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  __testing.sessions.clear();
  __testing.tabLocks.clear();
  __testing.setBrowser(null);
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(__testing.config.checkpointsDir, { recursive: true, force: true });
});

test('handoff request queued before click and hands mutations pauses them atomically', async () => {
  const tabId = 'atomic-tab';
  const { session, page } = makeSession(tabId);
  __testing.sessions.set('route-user', session);

  let releaseHolder;
  let holderEntered;
  const entered = new Promise(resolve => { holderEntered = resolve; });
  const holderGate = new Promise(resolve => { releaseHolder = resolve; });
  const holder = __testing.withTabLock(tabId, async () => {
    holderEntered();
    await holderGate;
  });
  await entered;

  const handoff = request(`/tabs/${tabId}/handoff`, {
    method: 'POST',
    body: { userId: 'route-user', action: 'request', reason: 'MFA' },
  });
  await waitFor(() => __testing.tabLocks.get(tabId)?.queue?.length === 1);
  const mutation = request(`/tabs/${tabId}/click`, {
    method: 'POST',
    body: { userId: 'route-user', selector: '.target' },
  });
  await waitFor(() => __testing.tabLocks.get(tabId)?.queue?.length === 2);
  const hands = request(`/tabs/${tabId}/hands`, {
    method: 'POST',
    body: { userId: 'route-user', steps: [{ action: 'wait', ms: 1 }] },
  });
  await waitFor(() => __testing.tabLocks.get(tabId)?.queue?.length === 3);

  releaseHolder();
  await holder;
  await expect(handoff).resolves.toMatchObject({ status: 200, body: { handoff: { status: 'paused' } } });
  await expect(mutation).resolves.toMatchObject({ status: 423, body: { code: 'handoff_paused' } });
  await expect(hands).resolves.toMatchObject({ status: 423, body: { code: 'handoff_paused' } });
  expect(page.locator).not.toHaveBeenCalled();
});

test('paused session and hands routes are protected until resume', async () => {
  const tabId = 'paused-tab';
  const { session, page } = makeSession(tabId);
  __testing.sessions.set('route-user', session);

  await expect(request(`/tabs/${tabId}/handoff`, {
    method: 'POST', body: { userId: 'route-user', action: 'request' },
  })).resolves.toMatchObject({ status: 200 });
  await expect(request('/sessions/route-user', { method: 'DELETE' }))
    .resolves.toMatchObject({ status: 423, body: { tabId } });
  await expect(request(`/tabs/${tabId}/hands`, {
    method: 'POST', body: { userId: 'route-user', steps: [{ action: 'wait', ms: 1 }] },
  })).resolves.toMatchObject({ status: 423 });

  await expect(request(`/tabs/${tabId}/handoff`, {
    method: 'POST', body: { userId: 'route-user', action: 'resume' },
  })).resolves.toMatchObject({ status: 200, body: { handoff: { status: 'resumed' } } });
  await expect(request(`/tabs/${tabId}/evaluate`, {
    method: 'POST', body: { userId: 'route-user', expression: 'document.title' },
  })).resolves.toMatchObject({ status: 200, body: { ok: true, result: 'evaluated:document.title' } });
  await request(`/tabs/${tabId}/handoff`, {
    method: 'POST', body: { userId: 'route-user', action: 'request' },
  });
  await expect(request(`/tabs/${tabId}/handoff`, {
    method: 'POST', body: { userId: 'route-user', action: 'cancel' },
  })).resolves.toMatchObject({ status: 200, body: { handoff: { status: 'cancelled' } } });
  await expect(request(`/tabs/${tabId}/evaluate`, {
    method: 'POST', body: { userId: 'route-user', expression: 'location.href' },
  })).resolves.toMatchObject({ status: 200, body: { ok: true, result: 'evaluated:location.href' } });
  expect(page.evaluate).toHaveBeenCalledTimes(2);
});

test('handoff wins atomically against a concurrent session timeout', async () => {
  const tabId = 'timeout-race-tab';
  const { session } = makeSession(tabId);
  __testing.sessions.set('timeout-user', session);

  let releaseHolder;
  let holderEntered;
  const entered = new Promise(resolve => { holderEntered = resolve; });
  const holderGate = new Promise(resolve => { releaseHolder = resolve; });
  const holder = __testing.withTabLock(tabId, async () => {
    holderEntered();
    await holderGate;
  });
  await entered;

  const handoff = request(`/tabs/${tabId}/handoff`, {
    method: 'POST', body: { userId: 'timeout-user', action: 'request' },
  });
  await waitFor(() => __testing.tabLocks.get(tabId)?.queue?.length === 1);
  const timeout = __testing.closeReapableSession('timeout-user', session, 'session_timeout');
  await waitFor(() => __testing.tabLocks.get(tabId)?.queue?.length === 2);

  releaseHolder();
  await holder;
  await expect(handoff).resolves.toMatchObject({ status: 200, body: { handoff: { status: 'paused' } } });
  await expect(timeout).resolves.toBe(false);
  expect(__testing.sessions.get('timeout-user')).toBe(session);
  expect(session.context.close).not.toHaveBeenCalled();
});

test('type_secret enforces the live iframe origin and rejects frame navigation and opaque frames', async () => {
  const tabId = 'iframe-tab';
  const { session, childUrl, fills } = makeSemanticIframeSession(tabId);
  __testing.sessions.set('iframe-user', session);

  const observe = await request(`/tabs/${tabId}/observe`, {
    method: 'POST', body: { userId: 'iframe-user' },
  });
  expect(observe.status).toBe(200);
  const iframeNode = observe.body.nodes.find(node => node.name === 'Password');
  expect(iframeNode).toMatchObject({
    frameKey: expect.stringMatching(/^frame_/),
    provenance: { frame: { url: 'https://evil.example/form' } },
  });

  await expect(request('/sessions/iframe-user/secrets', {
    method: 'POST',
    body: { secretId: 'main_only', value: 'not-for-iframe', allowedOrigins: ['https://allowed.example'] },
  })).resolves.toMatchObject({ status: 200 });
  const blockedPlan = await request(`/tabs/${tabId}/actions/plan`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', snapshotId: observe.body.snapshotId,
      action: { kind: 'type_secret', nodeId: iframeNode.id, secretId: 'main_only' },
      policy: { confirmSensitive: false },
    },
  });
  const blocked = await request(`/tabs/${tabId}/actions/execute`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', contractId: blockedPlan.body.contractId,
      postconditions: [{ kind: 'node_exists', nodeId: iframeNode.id }],
    },
  });
  expect(blocked).toMatchObject({ status: 409, body: { ok: false, status: 'blocked', reasons: ['target_frame_origin_not_allowed'] } });
  expect(fills).toHaveLength(0);

  const currentSnapshot = session.tabGroups.get('default').get(tabId).lastSemanticSnapshot;
  await request('/sessions/iframe-user/secrets', {
    method: 'POST',
    body: { secretId: 'iframe_ok', value: 'iframe-secret', allowedOrigins: ['https://evil.example'] },
  });
  const allowedPlan = await request(`/tabs/${tabId}/actions/plan`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', snapshotId: currentSnapshot.snapshotId,
      action: { kind: 'type_secret', nodeId: currentSnapshot.nodes.find(node => node.name === 'Password').id, secretId: 'iframe_ok' },
      policy: { confirmSensitive: false },
    },
  });
  const allowed = await request(`/tabs/${tabId}/actions/execute`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', contractId: allowedPlan.body.contractId,
      postconditions: [{ kind: 'node_exists', name: 'Password', role: 'textbox' }],
    },
  });
  expect(allowed).toMatchObject({ status: 200, body: { ok: true, status: 'executed_verified' } });
  expect(fills).toEqual([{ frameLabel: 'child', value: 'iframe-secret' }]);

  const beforeNavigation = session.tabGroups.get('default').get(tabId).lastSemanticSnapshot;
  const navigationPlan = await request(`/tabs/${tabId}/actions/plan`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', snapshotId: beforeNavigation.snapshotId,
      action: { kind: 'type_secret', nodeId: beforeNavigation.nodes.find(node => node.name === 'Password').id, secretId: 'iframe_ok' },
      policy: { confirmSensitive: false },
    },
  });
  childUrl.value = 'https://navigated.example/form';
  const navigated = await request(`/tabs/${tabId}/actions/execute`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', contractId: navigationPlan.body.contractId,
      postconditions: [{ kind: 'node_exists', name: 'Password' }],
    },
  });
  expect(navigated.body).toMatchObject({ ok: false, status: 'rejected_stale' });

  const opaqueObservation = await request(`/tabs/${tabId}/observe`, {
    method: 'POST', body: { userId: 'iframe-user' },
  });
  childUrl.value = 'about:srcdoc';
  const srcdocObservation = await request(`/tabs/${tabId}/observe`, {
    method: 'POST', body: { userId: 'iframe-user' },
  });
  expect(opaqueObservation.status).toBe(200);
  const opaqueNode = srcdocObservation.body.nodes.find(node => node.name === 'Password');
  const opaquePlan = await request(`/tabs/${tabId}/actions/plan`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', snapshotId: srcdocObservation.body.snapshotId,
      action: { kind: 'type_secret', nodeId: opaqueNode.id, secretId: 'iframe_ok' },
      policy: { confirmSensitive: false },
    },
  });
  const opaque = await request(`/tabs/${tabId}/actions/execute`, {
    method: 'POST',
    body: {
      userId: 'iframe-user', contractId: opaquePlan.body.contractId,
      postconditions: [{ kind: 'node_exists', nodeId: opaqueNode.id }],
    },
  });
  expect(opaque).toMatchObject({ status: 409, body: { ok: false, status: 'blocked', reasons: ['target_frame_origin_unavailable'] } });
});

test('checkpoint forks reserve newUserId across fork and normal session creation races', async () => {
  const storageState = { cookies: [{ name: 'session', value: 'checkpoint', domain: 'example.com', path: '/' }], origins: [] };
  const sourceContext = {
    pages: () => [],
    storageState: jest.fn(async () => storageState),
    close: jest.fn(async () => {}),
  };
  __testing.sessions.set('source-user', {
    context: sourceContext,
    tabGroups: new Map(),
    secrets: new Map(),
    lastAccess: Date.now(),
    activeOperations: 0,
  });
  const checkpoint = await request('/sessions/source-user/checkpoints', {
    method: 'POST', body: { checkpointId: 'race_source' },
  });
  expect(checkpoint).toMatchObject({ status: 200, body: { checkpointId: 'race_source' } });

  let releaseContext;
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  const contextOptions = [];
  const createdContexts = [];
  const browser = {
    isConnected: () => true,
    newContext: jest.fn(async options => {
      contextOptions.push(options);
      await contextGate;
      const page = {
        url: () => 'about:blank',
        on: jest.fn(),
        off: jest.fn(),
        isClosed: () => false,
        close: jest.fn(async () => {}),
      };
      const context = {
        addInitScript: jest.fn(async () => {}),
        newPage: jest.fn(async () => page),
        pages: () => [page],
        close: jest.fn(async () => {}),
      };
      createdContexts.push(context);
      return context;
    }),
  };
  __testing.setBrowser(browser);

  const winner = request('/sessions/source-user/forks', {
    method: 'POST',
    body: { checkpointId: 'race_source', newUserId: 'fork-target', sessionKey: 'fork' },
  });
  await waitFor(() => __testing.sessionReservations.reservations.has('fork-target'));
  const losingFork = await request('/sessions/source-user/forks', {
    method: 'POST',
    body: { checkpointId: 'race_source', newUserId: 'fork-target', sessionKey: 'other' },
  });
  const normalCreation = await request('/tabs', {
    method: 'POST',
    body: { userId: 'fork-target', sessionKey: 'normal' },
  });
  expect(losingFork.status).toBe(409);
  expect(normalCreation).toMatchObject({ status: 409, body: { code: 'session_reserved' } });

  releaseContext();
  await expect(winner).resolves.toMatchObject({ status: 200, body: { userId: 'fork-target', checkpointId: 'race_source' } });
  expect(contextOptions).toHaveLength(1);
  expect(contextOptions[0].storageState).toEqual(storageState);
  expect(createdContexts[0].close).not.toHaveBeenCalled();
  expect(__testing.sessions.get('fork-target')?.context).toBe(createdContexts[0]);
});
