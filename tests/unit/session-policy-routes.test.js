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

function redirectResponse(status, url, location, extraHeaders = {}) {
  return {
    status: () => status,
    url: () => url,
    headers: () => ({ ...(location ? { location } : {}), ...extraHeaders }),
  };
}

async function makeRedirectGuard(userId, policy) {
  await request(`/sessions/${userId}/policy`, { method: 'POST', body: policy });
  let handler;
  const hopResponses = [];
  const context = {
    route: jest.fn(async (_pattern, routeHandler) => { handler = routeHandler; }),
    request: { fetch: jest.fn(async () => hopResponses.shift()) },
  };
  await __testing.installSessionPolicyNavigationGuard(context, userId);
  const makeRoute = (first, {
    url = 'https://app.example.com/start', method = 'GET', postData = null, headers = {},
  } = {}) => ({
    request: () => ({
      isNavigationRequest: () => true,
      url: () => url,
      method: () => method,
      headers: () => headers,
      postDataBuffer: () => (postData === null ? null : Buffer.from(postData)),
    }),
    fetch: jest.fn(async () => first),
    fulfill: jest.fn(async () => {}),
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  });
  return { context, hopResponses, handle: route => handler(route), makeRoute };
}

test('a redirect onto a denied origin is refused before the hop is fetched', async () => {
  const guard = await makeRedirectGuard('redirects', { allowedOrigins: ['https://app.example.com'] });
  const route = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', 'https://evil.example.com/landing'));
  await guard.handle(route);
  expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0 });
  expect(guard.context.request.fetch).not.toHaveBeenCalled();
  expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(route.fulfill).not.toHaveBeenCalled();
});

test('every hop of an allowed chain is checked, fetched without auto-redirects, and served', async () => {
  const guard = await makeRedirectGuard('redirects-allowed', {
    allowedOrigins: ['https://app.example.com', 'https://sso.example.com'],
  });
  guard.hopResponses.push(
    redirectResponse(302, 'https://app.example.com/next', 'https://sso.example.com/auth'),
    redirectResponse(200, 'https://sso.example.com/auth', null, { 'set-cookie': 'sso=1', 'content-type': 'text/html' }),
  );
  const route = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', '/next'));
  await guard.handle(route);

  expect(guard.context.request.fetch.mock.calls.map(([url, opts]) => [url, opts.maxRedirects])).toEqual([
    ['https://app.example.com/next', 0],
    ['https://sso.example.com/auth', 0],
  ]);
  expect(route.abort).not.toHaveBeenCalled();
  expect(route.fulfill).toHaveBeenCalledTimes(1);
  // The jar already stored the final hop's cookie against its own URL; the
  // browser must not re-apply it to the originally requested URL.
  const [{ headers }] = route.fulfill.mock.calls[0];
  expect(headers).toEqual({ 'content-type': 'text/html' });

  // A denial deep in an otherwise allowed chain still stops it at that hop.
  guard.hopResponses.push(redirectResponse(302, 'https://sso.example.com/auth', 'https://evil.example.com/x'));
  const deep = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', 'https://sso.example.com/auth'));
  await guard.handle(deep);
  expect(deep.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(deep.fulfill).not.toHaveBeenCalled();
});

test('a chain that reaches the redirect limit is refused, never handed to the browser as a 3xx', async () => {
  const guard = await makeRedirectGuard('redirects-loop', { allowedOrigins: ['https://app.example.com'] });
  for (let i = 1; i <= 25; i++) {
    guard.hopResponses.push(redirectResponse(302, `https://app.example.com/hop${i}`, `/hop${i + 1}`));
  }
  const route = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', '/hop1'));
  await guard.handle(route);
  expect(guard.context.request.fetch).toHaveBeenCalledTimes(20);
  expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(route.fulfill).not.toHaveBeenCalled();

  // Exactly at the limit is still served.
  const atLimit = await makeRedirectGuard('redirects-limit', { allowedOrigins: ['https://app.example.com'] });
  for (let i = 1; i <= 19; i++) {
    atLimit.hopResponses.push(redirectResponse(302, `https://app.example.com/hop${i}`, `/hop${i + 1}`));
  }
  atLimit.hopResponses.push(redirectResponse(200, 'https://app.example.com/hop20', null));
  const ok = atLimit.makeRoute(redirectResponse(302, 'https://app.example.com/start', '/hop1'));
  await atLimit.handle(ok);
  expect(atLimit.context.request.fetch).toHaveBeenCalledTimes(20);
  expect(ok.fulfill).toHaveBeenCalledTimes(1);
  expect(ok.abort).not.toHaveBeenCalled();
});

test('a form POST is not resent, with its body or cookies, to a 301/302/303 redirect target', async () => {
  for (const status of [301, 302, 303]) {
    const guard = await makeRedirectGuard(`redirects-post-${status}`, {
      allowedOrigins: ['https://app.example.com', 'https://pay.example.com'],
    });
    guard.hopResponses.push(redirectResponse(200, 'https://pay.example.com/collect', null));
    const route = guard.makeRoute(
      redirectResponse(status, 'https://app.example.com/checkout', 'https://pay.example.com/collect'),
      {
        url: 'https://app.example.com/checkout',
        method: 'POST',
        postData: 'card=4111&cvv=123',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': '17',
          Cookie: 'app_session=SECRET',
          Authorization: 'Bearer app-token',
          Origin: 'https://app.example.com',
          Referer: 'https://app.example.com/checkout?cart=abc123',
          'User-Agent': 'goliath-test',
        },
      },
    );
    await guard.handle(route);
    expect(guard.context.request.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = guard.context.request.fetch.mock.calls[0];
    expect(url).toBe('https://pay.example.com/collect');
    expect(opts.method).toBe('GET');
    expect(opts).not.toHaveProperty('data');
    expect(opts.headers).toEqual({
      origin: 'null',
      referer: 'https://app.example.com/',
      'user-agent': 'goliath-test',
    });
    expect(route.fulfill).toHaveBeenCalledTimes(1);
  }
});

test('307/308 keep the method and body but never forward cookies or cross-origin credentials', async () => {
  for (const status of [307, 308]) {
    const guard = await makeRedirectGuard(`redirects-keep-${status}`, {
      allowedOrigins: ['https://app.example.com', 'https://api.example.com'],
    });
    guard.hopResponses.push(
      redirectResponse(status, 'https://app.example.com/v2/submit', 'https://api.example.com/submit'),
      redirectResponse(200, 'https://api.example.com/submit', null),
    );
    const route = guard.makeRoute(
      redirectResponse(status, 'https://app.example.com/submit', '/v2/submit'),
      {
        url: 'https://app.example.com/submit',
        method: 'POST',
        postData: 'a=1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'app_session=SECRET',
          authorization: 'Bearer app-token',
          origin: 'https://app.example.com',
          referer: 'https://app.example.com/form?step=2',
        },
      },
    );
    await guard.handle(route);
    const [[sameUrl, same], [crossUrl, cross]] = guard.context.request.fetch.mock.calls;
    // Same-origin hop: body and authorization survive, the cookie header does not.
    expect(sameUrl).toBe('https://app.example.com/v2/submit');
    expect(same.method).toBe('POST');
    expect(same.data.toString()).toBe('a=1');
    expect(same.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Bearer app-token',
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/form?step=2',
    });
    // Cross-origin hop straight off the initiating origin: authorization is
    // dropped and the referrer trimmed, but Origin is not yet tainted.
    expect(crossUrl).toBe('https://api.example.com/submit');
    expect(cross.method).toBe('POST');
    expect(cross.data.toString()).toBe('a=1');
    expect(cross.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/',
    });
    expect(route.fulfill).toHaveBeenCalledTimes(1);
  }
});

test('a 307 chain that has already left the initiating origin reports Origin: null', async () => {
  const guard = await makeRedirectGuard('redirects-tainted', {
    allowedOrigins: ['https://app.example.com', 'https://a.example.com', 'https://b.example.com'],
  });
  guard.hopResponses.push(
    redirectResponse(307, 'https://a.example.com/in', 'https://b.example.com/out'),
    redirectResponse(200, 'https://b.example.com/out', null),
  );
  const route = guard.makeRoute(
    redirectResponse(307, 'https://app.example.com/go', 'https://a.example.com/in'),
    { url: 'https://app.example.com/go', method: 'POST', postData: 'x=1', headers: { origin: 'https://app.example.com' } },
  );
  await guard.handle(route);
  const [[, first], [, second]] = guard.context.request.fetch.mock.calls;
  expect(first.headers.origin).toBe('https://app.example.com');
  expect(second.headers.origin).toBe('null');
  expect(route.fulfill).toHaveBeenCalledTimes(1);
});

test('non-redirect responses and redirects without a Location are served as-is', async () => {
  const guard = await makeRedirectGuard('redirects-plain', { allowedOrigins: ['https://app.example.com'] });
  const plainResponse = redirectResponse(200, 'https://app.example.com/start', null, { 'set-cookie': 'a=1' });
  const plain = guard.makeRoute(plainResponse);
  await guard.handle(plain);
  expect(plain.fulfill).toHaveBeenCalledWith({ response: plainResponse });

  const bare = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', null));
  await guard.handle(bare);
  expect(bare.fulfill).toHaveBeenCalledTimes(1);
  expect(bare.abort).not.toHaveBeenCalled();
  expect(guard.context.request.fetch).not.toHaveBeenCalled();
});

test('an unresolvable Location or a failed fetch fails closed', async () => {
  const guard = await makeRedirectGuard('redirects-closed', { allowedOrigins: ['https://app.example.com'] });

  const garbage = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', 'http://[not-a-host/'));
  await guard.handle(garbage);
  expect(garbage.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(garbage.fulfill).not.toHaveBeenCalled();

  const failingFirst = guard.makeRoute(null);
  failingFirst.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
  await guard.handle(failingFirst);
  expect(failingFirst.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(failingFirst.continue).not.toHaveBeenCalled();

  guard.context.request.fetch.mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });
  const failingHop = guard.makeRoute(redirectResponse(302, 'https://app.example.com/start', '/next'));
  await guard.handle(failingHop);
  expect(failingHop.abort).toHaveBeenCalledWith('blockedbyclient');
  expect(failingHop.fulfill).not.toHaveBeenCalled();
});

test('sessions without origin rules keep the untouched request path', async () => {
  await request('/sessions/norules/policy', {
    method: 'POST', body: { actions: { evaluate: 'deny' } },
  });
  let handler;
  const context = { route: jest.fn(async (_pattern, routeHandler) => { handler = routeHandler; }) };
  await __testing.installSessionPolicyNavigationGuard(context, 'norules');
  const route = {
    request: () => ({ isNavigationRequest: () => true, url: () => 'https://anywhere.example/page' }),
    fetch: jest.fn(async () => { throw new Error('must not resolve redirects without origin rules'); }),
    fulfill: jest.fn(async () => {}),
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  };
  await handler(route);
  expect(route.continue).toHaveBeenCalledTimes(1);
  expect(route.fetch).not.toHaveBeenCalled();
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
