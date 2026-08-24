import http from 'node:http';
import fs from 'node:fs/promises';
import { jest } from '@jest/globals';

jest.unstable_mockModule('camoufox-js', () => ({ launchOptions: jest.fn(async () => ({})) }));
jest.unstable_mockModule('camoufox-js/dist/virtdisplay.js', () => ({ VirtualDisplay: class VirtualDisplay {} }));
jest.unstable_mockModule('impit', () => ({ Impit: class Impit {} }));

let server;
let baseUrl;
let __testing;

function makeSession(tabId, { url = 'https://app.example.com/page', name = 'Next' } = {}) {
  const locator = {
    click: jest.fn(async () => {}),
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    first() { return locator; },
    nth() { return locator; },
    count: jest.fn(async () => 1),
    ariaSnapshot: jest.fn(async () => `- button "${name}"`),
    getAttribute: jest.fn(async () => null),
    locator: jest.fn(() => ({
      count: jest.fn(async () => 0),
      first() { return this; },
      locator() { return this; },
    })),
  };
  const frame = {
    url: () => url,
    name: () => '',
    getByRole: () => locator,
    locator: () => locator,
  };
  const page = {
    url: () => url,
    mainFrame: () => frame,
    frames: () => [frame],
    getByRole: frame.getByRole,
    locator: frame.locator,
    isClosed: () => false,
    evaluate: jest.fn(async expression => `evaluated:${expression}`),
    keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
    mouse: {
      move: jest.fn(async () => {}), down: jest.fn(async () => {}), up: jest.fn(async () => {}), wheel: jest.fn(async () => {}),
    },
    waitForTimeout: jest.fn(async () => {}),
    waitForLoadState: jest.fn(async () => {}),
    goBack: jest.fn(async () => {}),
    goForward: jest.fn(async () => {}),
    reload: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    removeAllListeners: jest.fn(),
  };
  const tabState = {
    page,
    refs: new Map([['e1', { role: 'button', name, nth: 0, frameKey: 'main', frameUrl: url }]]),
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
  };
  const session = {
    context: { close: jest.fn(async () => {}), pages: () => [page] },
    tabGroups: new Map([['default', new Map([[tabId, tabState]])]]),
    secrets: new Map(),
    lastAccess: Date.now(),
    activeOperations: 0,
  };
  return { session, page, locator };
}

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const serverModule = await import('../../server.js');
  ({ __testing } = serverModule);
  server = http.createServer(serverModule.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  for (const userId of ['free', 'restricted', 'dangerous', 'origin', 'network']) {
    await request(`/sessions/${userId}/policy`, { method: 'DELETE' });
  }
  __testing.sessions.clear();
  __testing.tabLocks.clear();
  __testing.setBrowser(null);
  __testing.config.dangerousActionsMode = 'confirm';
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(__testing.config.checkpointsDir, { recursive: true, force: true });
});

test('no registered policy preserves existing unrestricted behavior', async () => {
  const fake = makeSession('free-tab');
  __testing.sessions.set('free', fake.session);
  const result = await request('/tabs/free-tab/click', { method: 'POST', body: { userId: 'free', ref: 'e1' } });
  expect(result).toMatchObject({ status: 200, body: { ok: true } });
  expect(fake.locator.click).toHaveBeenCalledTimes(1);
});

test('a pre-provisioned capability deny blocks the route and emits a violation event', async () => {
  const registered = await request('/sessions/restricted/policy', {
    method: 'POST',
    body: { actions: { evaluate: 'deny' } },
  });
  expect(registered).toMatchObject({ status: 200, body: { ok: true } });

  const fake = makeSession('restricted-tab');
  __testing.sessions.set('restricted', fake.session);
  const events = [];
  const listener = payload => events.push(payload);
  __testing.pluginEvents.on('session:policy:violation', listener);
  try {
    const result = await request('/tabs/restricted-tab/evaluate', {
      method: 'POST', body: { userId: 'restricted', expression: 'document.title' },
    });
    expect(result).toMatchObject({
      status: 403,
      body: { code: 'policy_violation', action: 'evaluate', category: 'action', reason: 'action_denied' },
    });
    expect(fake.page.evaluate).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 'restricted', tabId: 'restricted-tab', action: 'evaluate' });
  } finally {
    __testing.pluginEvents.off('session:policy:violation', listener);
  }
});

test('origin allowlists fail closed and support subdomain-only wildcards', async () => {
  await request('/sessions/origin/policy', {
    method: 'POST', body: { allowedOrigins: ['https://*.example.com'] },
  });
  const allowed = makeSession('allowed-tab', { url: 'https://app.example.com/page' });
  __testing.sessions.set('origin', allowed.session);
  expect(await request('/tabs/allowed-tab/click', {
    method: 'POST', body: { userId: 'origin', ref: 'e1' },
  })).toMatchObject({ status: 200, body: { ok: true } });

  const blocked = makeSession('blocked-tab', { url: 'https://example.com/page' });
  __testing.sessions.set('origin', blocked.session);
  const result = await request('/tabs/blocked-tab/click', {
    method: 'POST', body: { userId: 'origin', ref: 'e1' },
  });
  expect(result).toMatchObject({
    status: 403,
    body: { code: 'policy_violation', category: 'origin', reason: 'origin_not_allowed' },
  });
  expect(blocked.locator.click).not.toHaveBeenCalled();
});

test('origin-scoped policies fail closed for browser history with an unknown destination', async () => {
  await request('/sessions/origin/policy', {
    method: 'POST', body: { allowedOrigins: ['https://app.example.com'] },
  });
  const fake = makeSession('history-tab');
  __testing.sessions.set('origin', fake.session);
  const result = await request('/tabs/history-tab/back', {
    method: 'POST', body: { userId: 'origin' },
  });
  expect(result).toMatchObject({
    status: 403,
    body: { code: 'policy_violation', category: 'origin', reason: 'origin_unavailable' },
  });
  expect(fake.page.goBack).not.toHaveBeenCalled();
});

test('browser request interception blocks denied top-level and iframe navigations', async () => {
  await request('/sessions/network/policy', {
    method: 'POST', body: { allowedOrigins: ['https://app.example.com'] },
  });
  let handler;
  const context = {
    route: jest.fn(async (_pattern, routeHandler) => { handler = routeHandler; }),
  };
  await __testing.installSessionPolicyNavigationGuard(context, 'network');
  expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));

  const intercepted = {
    request: () => ({ isNavigationRequest: () => true, url: () => 'https://blocked.example/frame' }),
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  };
  await handler(intercepted);
  expect(intercepted.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(intercepted.continue).not.toHaveBeenCalled();
});

test('dangerous category deny overrides confirm and the global brake mode', async () => {
  await request('/sessions/dangerous/policy', {
    method: 'POST', body: { dangerousActions: { payment: 'deny' } },
  });
  const fake = makeSession('pay-tab', { url: 'https://shop.example/checkout', name: 'Pay now' });
  __testing.sessions.set('dangerous', fake.session);
  __testing.config.dangerousActionsMode = 'off';
  const result = await request('/tabs/pay-tab/click', {
    method: 'POST', body: { userId: 'dangerous', ref: 'e1', confirm: true },
  });
  expect(result).toMatchObject({
    status: 403,
    body: { code: 'policy_violation', action: 'click', category: 'payment', reason: 'dangerous_action_denied' },
  });
  expect(fake.locator.click).not.toHaveBeenCalled();
});

test('dangerous category deny also blocks confirmed Hands steps', async () => {
  await request('/sessions/dangerous/policy', {
    method: 'POST', body: { dangerousActions: { payment: 'deny' } },
  });
  const fake = makeSession('pay-hands-tab', { url: 'https://shop.example/checkout', name: 'Pay now' });
  __testing.sessions.set('dangerous', fake.session);
  __testing.config.dangerousActionsMode = 'off';
  const result = await request('/tabs/pay-hands-tab/hands', {
    method: 'POST',
    body: { userId: 'dangerous', steps: [{ action: 'click', ref: 'e1', confirm: true }] },
  });
  expect(result).toMatchObject({
    status: 403,
    body: { code: 'policy_violation', action: 'click', category: 'payment', reason: 'dangerous_action_denied' },
  });
  expect(fake.locator.click).not.toHaveBeenCalled();
});

test('deleting a policy restores unrestricted behavior for the live identity', async () => {
  await request('/sessions/restricted/policy', {
    method: 'POST', body: { actions: { evaluate: 'deny' } },
  });
  const fake = makeSession('restore-tab');
  __testing.sessions.set('restricted', fake.session);
  expect((await request('/tabs/restore-tab/evaluate', {
    method: 'POST', body: { userId: 'restricted', expression: '1' },
  })).status).toBe(403);
  expect(await request('/sessions/restricted/policy', { method: 'DELETE' }))
    .toMatchObject({ status: 200, body: { ok: true, removed: true } });
  expect(await request('/tabs/restore-tab/evaluate', {
    method: 'POST', body: { userId: 'restricted', expression: '1' },
  })).toMatchObject({ status: 200, body: { ok: true, result: 'evaluated:1' } });
});

test('legacy act cannot bypass a denied underlying capability', async () => {
  await request('/sessions/restricted/policy', {
    method: 'POST', body: { actions: { click: 'deny' } },
  });
  const fake = makeSession('legacy-act-tab');
  __testing.sessions.set('restricted', fake.session);
  const result = await request('/act', {
    method: 'POST', body: { userId: 'restricted', targetId: 'legacy-act-tab', kind: 'click', ref: 'e1' },
  });
  expect(result).toMatchObject({
    status: 403,
    body: { code: 'policy_violation', action: 'click', category: 'action' },
  });
  expect(fake.locator.click).not.toHaveBeenCalled();
});
