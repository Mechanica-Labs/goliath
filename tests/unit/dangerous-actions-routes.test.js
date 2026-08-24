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

const PAGE_URL = 'https://www.linkedin.com/messaging/thread/abc/';

/**
 * Fake page modelled on the Playwright surface the brake uses: utility-world
 * `ariaSnapshot`, `count`, `getAttribute`, and relative xpath locators for the
 * owning form / nearest button container. Nodes describe elements:
 *   { role, name, form?: { action, submitName, buttons }, container?: { buttons }, broken? }
 */
function ariaLine(role, name) {
  return name ? `- ${role} "${name.replace(/"/g, '\\"')}"` : `- ${role}`;
}

function makeLocator(node, page) {
  const locator = {
    node,
    click: jest.fn(async () => {}),
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    boundingBox: jest.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })),
    first() { return locator; },
    nth() { return locator; },
    count: jest.fn(async () => (node ? 1 : 0)),
    ariaSnapshot: jest.fn(async () => {
      if (!node) throw new Error('locator resolved to nothing');
      if (node.broken) throw new Error('Timeout 2500ms exceeded');
      return ariaLine(node.role, node.name);
    }),
    getAttribute: jest.fn(async (attr) => (attr === 'action' ? node?.action ?? null : null)),
    locator: (sub) => {
      if (sub.startsWith('xpath=ancestor-or-self::form')) {
        const form = node?.form;
        return makeLocator(form ? { role: 'form', name: '', action: form.action, buttons: form.buttons, submitName: form.submitName } : null, page);
      }
      if (sub.startsWith('xpath=ancestor::*')) {
        const container = node?.container;
        return makeLocator(container ? { role: 'generic', name: '', buttons: container.buttons } : null, page);
      }
      if (sub === 'button[type="submit"], input[type="submit"]') {
        return makeLocator(node?.submitName ? { role: 'button', name: node.submitName } : null, page);
      }
      if (sub === 'button:not([type])') return makeLocator(null, page);
      return makeLocator(null, page);
    },
  };
  // Containers/forms list their buttons in the snapshot.
  if (node && Array.isArray(node.buttons)) {
    locator.ariaSnapshot = jest.fn(async () => [ariaLine(node.role, node.name), ...node.buttons.map(b => '  ' + ariaLine('button', b))].join('\n'));
  }
  return locator;
}

function makeSession(tabId, { refs = {}, selectors = {}, active = null } = {}) {
  const nodes = { ...refs, ...selectors };
  const refMap = new Map(Object.entries(refs).map(([ref, node]) => [ref, { nth: 0, frameKey: 'main', role: node.role, name: node.name }]));
  const refLocators = new Map();
  const selectorLocators = new Map();
  const page = {};
  const frame = {
    url: () => PAGE_URL,
    name: () => '',
    getByRole: (role, { name } = {}) => {
      const key = `${role}:${name}`;
      if (!refLocators.has(key)) {
        const node = Object.values(refs).find(n => n.role === role && n.name === name) || null;
        refLocators.set(key, makeLocator(node, page));
      }
      return refLocators.get(key);
    },
    locator: (selector) => {
      if (selector === ':focus') return makeLocator(active, page);
      if (!selectorLocators.has(selector)) selectorLocators.set(selector, makeLocator(selectors[selector] || null, page));
      return selectorLocators.get(selector);
    },
  };
  Object.assign(page, {
    url: () => PAGE_URL,
    isClosed: () => false,
    mainFrame: () => frame,
    frames: () => [frame],
    locator: frame.locator,
    getByRole: frame.getByRole,
    keyboard: { press: jest.fn(async () => {}), type: jest.fn(async () => {}) },
    mouse: { move: jest.fn(async () => {}), down: jest.fn(async () => {}), up: jest.fn(async () => {}), wheel: jest.fn(async () => {}) },
    fill: jest.fn(async () => {}),
    focus: jest.fn(async () => {}),
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    close: jest.fn(async () => {}),
    removeAllListeners: jest.fn(),
  });
  const tabState = {
    page,
    refs: refMap,
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
    downloads: [],
    lastAccess: Date.now(),
    activeOperations: 0,
  };
  return { session, tabState, page, refLocators, selectorLocators, nodes };
}

async function request(pathname, { method = 'POST', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function clickedLocators(fake) {
  return [...fake.refLocators.values(), ...fake.selectorLocators.values()].filter(l => l.click.mock.calls.length > 0);
}

beforeAll(async () => {
  ({ app, __testing } = await import('../../server.js'));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  __testing.sessions.clear();
  __testing.tabLocks.clear();
  __testing.setBrowser(null);
  __testing.config.dangerousActionsMode = 'confirm';
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(__testing.config.checkpointsDir, { recursive: true, force: true });
});

test('default mode is confirm', () => {
  expect(__testing.config.dangerousActionsMode).toBe('confirm');
});

test('click on a "Send" ref returns approval_required and does not click', async () => {
  const tabId = 'send-tab';
  const fake = makeSession(tabId, { refs: { e1: { role: 'button', name: 'Send' }, e2: { role: 'button', name: 'Next' } } });
  __testing.sessions.set('agent', fake.session);

  const refused = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1' } });
  expect(refused.status).toBe(200);
  expect(refused.body).toMatchObject({
    ok: false, status: 'approval_required', action: 'Click', kind: 'click', category: 'send',
    risk: 'external_side_effect', element: 'Send', role: 'button', domain: 'www.linkedin.com', source: 'element',
  });
  expect(typeof refused.body.hint).toBe('string');
  expect(clickedLocators(fake)).toHaveLength(0);
  expect(fake.page.mouse.down).not.toHaveBeenCalled();

  const allowed = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e2' } });
  expect(allowed.body).toMatchObject({ ok: true });
  expect(allowed.body.dangerous).toBeUndefined();
  expect(clickedLocators(fake)).toHaveLength(1);
});

test('confirm is bound to the refusal: it must follow a matching refusal on the same tab', async () => {
  const tabId = 'confirm-tab';
  const fake = makeSession(tabId, { refs: { e1: { role: 'button', name: 'Delete conversation' }, e2: { role: 'button', name: 'Send' } } });
  __testing.sessions.set('agent', fake.session);

  // Pre-emptive confirm with nothing refused yet is still refused (and says why).
  const preemptive = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1', confirm: true } });
  expect(preemptive.body).toMatchObject({ status: 'approval_required', category: 'delete' });
  expect(preemptive.body.hint).toMatch(/no matching refusal/);
  expect(clickedLocators(fake)).toHaveLength(0);

  // Now it matches the last refusal: proceeds, annotated, and the approval is consumed.
  const allowed = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1', confirm: true } });
  expect(allowed.body).toMatchObject({ ok: true, dangerous: { category: 'delete', risk: 'destructive', element: 'Delete conversation' } });
  expect(clickedLocators(fake)).toHaveLength(1);
  const again = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1', confirm: true } });
  expect(again.body).toMatchObject({ status: 'approval_required' });

  // An approval for "Delete conversation" does not cover "Send" (ref re-targeted after the human answered).
  await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1' } });
  const other = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e2', confirm: true } });
  expect(other.body).toMatchObject({ status: 'approval_required', category: 'send' });
  expect(clickedLocators(fake)).toHaveLength(1);

  // Only a boolean true counts.
  await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e2' } });
  const stringy = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e2', confirm: 'true' } });
  expect(stringy.body).toMatchObject({ status: 'approval_required' });
});

test('selector clicks use the accessible name from the utility world, not descendant text', async () => {
  const tabId = 'selector-tab';
  const fake = makeSession(tabId, {
    selectors: {
      'button.pay': { role: 'button', name: 'Pay now' },
      'button.next': { role: 'button', name: 'Continue' },
      // A card whose descendants mention Delete: its own accessible name is empty, so it is benign.
      '.card': { role: 'listitem', name: '', buttons: ['Delete', 'Reply'] },
      'input.msg': { role: 'textbox', name: 'Send' },
    },
  });
  __testing.sessions.set('agent', fake.session);

  const refused = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: 'button.pay' } });
  expect(refused.body).toMatchObject({ status: 'approval_required', category: 'payment', risk: 'financial', element: 'Pay now' });
  expect(fake.selectorLocators.get('button.pay').click).not.toHaveBeenCalled();

  const allowed = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: 'button.next' } });
  expect(allowed.body).toMatchObject({ ok: true });
  expect(fake.selectorLocators.get('button.next').click).toHaveBeenCalledTimes(1);

  const card = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: '.card' } });
  expect(card.body).toMatchObject({ ok: true });

  // Clicking into a text field only focuses it, whatever it is called.
  const field = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: 'input.msg' } });
  expect(field.body).toMatchObject({ ok: true });
});

test('lookup failure fails closed as unresolved_target', async () => {
  const tabId = 'broken-tab';
  const fake = makeSession(tabId, { selectors: { '#late': { role: 'button', name: 'Place order', broken: true } } });
  __testing.sessions.set('agent', fake.session);

  const refused = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: '#late' } });
  expect(refused.body).toMatchObject({ status: 'approval_required', category: 'unresolved_target', risk: 'unknown', source: 'lookup_failed', element: null });
  expect(refused.body.hint).toMatch(/could not be read/);
  expect(fake.selectorLocators.get('#late').click).not.toHaveBeenCalled();

  const confirmed = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', selector: '#late', confirm: true } });
  expect(confirmed.body).toMatchObject({ ok: true, dangerous: { category: 'unresolved_target' } });
});

test('type with pressEnter is judged by the form submit control before any text is typed', async () => {
  const tabId = 'type-tab';
  const fake = makeSession(tabId, {
    refs: {
      e1: { role: 'textbox', name: 'Write a message', form: { action: '', submitName: 'Send', buttons: ['Send'] } },
      e2: { role: 'textbox', name: 'Search', form: { action: '/search', submitName: 'Go', buttons: ['Go'] } },
    },
  });
  __testing.sessions.set('agent', fake.session);
  const msgBox = fake.page.getByRole('textbox', { name: 'Write a message' });

  const refused = await request(`/tabs/${tabId}/type`, { body: { userId: 'agent', ref: 'e1', text: 'hello', pressEnter: true } });
  expect(refused.body).toMatchObject({ status: 'approval_required', kind: 'type_submit', action: 'Type and submit', category: 'send', element: 'Send', role: 'button' });
  expect(msgBox.fill).not.toHaveBeenCalled();
  expect(fake.page.keyboard.press).not.toHaveBeenCalled();

  const typed = await request(`/tabs/${tabId}/type`, { body: { userId: 'agent', ref: 'e1', text: 'hello' } });
  expect(typed.body).toMatchObject({ ok: true });
  expect(msgBox.fill).toHaveBeenCalledWith('hello', expect.anything());

  const search = await request(`/tabs/${tabId}/type`, { body: { userId: 'agent', ref: 'e2', text: 'cats', pressEnter: true } });
  expect(search.body).toMatchObject({ ok: true });
  expect(search.body.dangerous).toBeUndefined();

  const confirmed = await request(`/tabs/${tabId}/type`, { body: { userId: 'agent', ref: 'e1', text: 'hello', pressEnter: true, confirm: true } });
  expect(confirmed.body).toMatchObject({ ok: true, dangerous: { category: 'send' } });
  expect(fake.page.keyboard.press).toHaveBeenCalledWith('Enter');
});

test('form-less chat composers are judged by the Send button next to the field', async () => {
  const tabId = 'composer-tab';
  const fake = makeSession(tabId, {
    refs: { e1: { role: 'textbox', name: 'Write a message', container: { buttons: ['Emoji', 'Attach', 'Send'] } } },
  });
  __testing.sessions.set('agent', fake.session);

  const refused = await request(`/tabs/${tabId}/type`, { body: { userId: 'agent', ref: 'e1', text: 'hi', pressEnter: true } });
  expect(refused.body).toMatchObject({ status: 'approval_required', category: 'send', element: 'Send', source: 'nearby_control' });
  expect(fake.page.keyboard.press).not.toHaveBeenCalled();
});

test('a plain Enter press (route, hands step, /act) is braked like a submit', async () => {
  const tabId = 'press-tab';
  const fake = makeSession(tabId, { active: { role: 'textbox', name: 'Amount', form: { action: '/transfers/execute', submitName: '', buttons: ['Go'] } } });
  __testing.sessions.set('agent', fake.session);

  const route = await request(`/tabs/${tabId}/press`, { body: { userId: 'agent', key: 'Enter' } });
  expect(route.body).toMatchObject({ status: 'approval_required', kind: 'submit', category: 'transfer', source: 'form_action' });
  const escape = await request(`/tabs/${tabId}/press`, { body: { userId: 'agent', key: 'Escape' } });
  expect(escape.body).toEqual({ ok: true });

  const hand = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'press', key: 'Enter' }] } });
  expect(hand.body).toMatchObject({ status: 'approval_required', failedStep: 0, approvalRequired: { kind: 'submit', category: 'transfer' } });

  const act = await request('/act', { body: { userId: 'agent', targetId: tabId, kind: 'press', key: 'Enter' } });
  expect(act.body).toMatchObject({ status: 'approval_required', category: 'transfer' });
  expect(fake.page.keyboard.press).toHaveBeenCalledTimes(1); // only Escape
  expect(fake.page.keyboard.press).toHaveBeenCalledWith('Escape');

  const confirmed = await request(`/tabs/${tabId}/press`, { body: { userId: 'agent', key: 'Enter', confirm: true } });
  expect(confirmed.body).toMatchObject({ ok: true, dangerous: { category: 'transfer' } });
});

test('/act click is braked too', async () => {
  const tabId = 'act-tab';
  const fake = makeSession(tabId, { refs: { e1: { role: 'button', name: 'Publish' } }, selectors: { '#ok': { role: 'button', name: 'OK' } } });
  __testing.sessions.set('agent', fake.session);

  const refused = await request('/act', { body: { userId: 'agent', targetId: tabId, kind: 'click', ref: 'e1' } });
  expect(refused.body).toMatchObject({ status: 'approval_required', category: 'publish', element: 'Publish' });
  expect(clickedLocators(fake)).toHaveLength(0);
  const allowed = await request('/act', { body: { userId: 'agent', targetId: tabId, kind: 'click', selector: '#ok' } });
  expect(allowed.body).toMatchObject({ ok: true });
  expect(clickedLocators(fake)).toHaveLength(1);
});

test('hands stop before a dangerous step, report it, and resume with a step-level confirm only', async () => {
  const tabId = 'hands-tab';
  const fake = makeSession(tabId, {
    refs: {
      e1: { role: 'textbox', name: 'Subject' },
      e2: { role: 'textbox', name: 'Body' },
      e3: { role: 'button', name: 'Send' },
    },
    selectors: { '#del': { role: 'button', name: 'Delete conversation' } },
  });
  __testing.sessions.set('agent', fake.session);

  const stopped = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [
    { action: 'type', ref: 'e1', text: 'Hi' },
    { action: 'type', ref: 'e2', text: 'Body text' },
    { action: 'click', ref: 'e3' },
    { action: 'click', selector: '#del' },
  ] } });
  expect(stopped.body).toMatchObject({
    ok: false, status: 'approval_required', completed: 2, total: 4, failedStep: 2,
    approvalRequired: { category: 'send', element: 'Send', domain: 'www.linkedin.com', step: 2 },
  });
  expect(stopped.body.results[2]).toMatchObject({ index: 2, action: 'click', ok: false, status: 'approval_required', category: 'send' });
  expect(clickedLocators(fake)).toHaveLength(0);

  // Hand-level confirm is not a thing: the dangerous step is refused again.
  const blanket = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', confirm: true, steps: [{ action: 'click', ref: 'e3' }, { action: 'click', selector: '#del' }] } });
  expect(blanket.body).toMatchObject({ status: 'approval_required', failedStep: 0 });
  expect(clickedLocators(fake)).toHaveLength(0);

  // Step-level confirm covers exactly the refused step; the next dangerous step is refused on its own.
  const resumed = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'click', ref: 'e3', confirm: true }, { action: 'click', selector: '#del', confirm: true }] } });
  expect(resumed.body).toMatchObject({ status: 'approval_required', completed: 1, failedStep: 1, approvalRequired: { category: 'delete', step: 1 } });
  expect(resumed.body.results[0]).toMatchObject({ ok: true, dangerous: { category: 'send' } });
  expect(clickedLocators(fake)).toHaveLength(1);
});

test('a targeted hands submit is judged by the owning form, and a bare submit by the focused form', async () => {
  const tabId = 'hands-submit-tab';
  const fake = makeSession(tabId, {
    refs: { e1: { role: 'textbox', name: 'Amount', form: { action: 'https://bank.example/transfers/execute', submitName: '', buttons: ['Go'] } } },
    active: { role: 'textbox', name: 'Amount', form: { action: '/transfers/execute', submitName: '', buttons: ['Go'] } },
  });
  __testing.sessions.set('agent', fake.session);

  const bare = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'type', ref: 'e1', text: '100' }, { action: 'submit' }] } });
  expect(bare.body).toMatchObject({ status: 'approval_required', failedStep: 1, approvalRequired: { kind: 'submit', category: 'transfer', source: 'form_action' } });
  expect(fake.page.keyboard.press).not.toHaveBeenCalled();

  const targeted = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'submit', ref: 'e1' }] } });
  expect(targeted.body).toMatchObject({ status: 'approval_required', approvalRequired: { kind: 'submit', category: 'transfer' } });

  // The approval is bound to the refused target: a bare submit cannot reuse the targeted refusal.
  const mismatch = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'submit', confirm: true }] } });
  expect(mismatch.body).toMatchObject({ status: 'approval_required' });
  await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'submit', ref: 'e1' }] } });
  const confirmed = await request(`/tabs/${tabId}/hands`, { body: { userId: 'agent', steps: [{ action: 'submit', ref: 'e1', confirm: true }] } });
  expect(confirmed.body).toMatchObject({ ok: true, completed: 1 });
  expect(confirmed.body.results[0]).toMatchObject({ dangerous: { category: 'transfer' } });
});

test('annotate mode acts and labels; off mode never classifies', async () => {
  const tabId = 'mode-tab';
  const fake = makeSession(tabId, { refs: { e1: { role: 'button', name: 'Send' } } });
  __testing.sessions.set('agent', fake.session);

  __testing.config.dangerousActionsMode = 'annotate';
  const annotated = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1' } });
  expect(annotated.body).toMatchObject({ ok: true, dangerous: { category: 'send' } });

  __testing.config.dangerousActionsMode = 'off';
  const off = await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1' } });
  expect(off.body).toMatchObject({ ok: true });
  expect(off.body.dangerous).toBeUndefined();
  expect(clickedLocators(fake)[0].click).toHaveBeenCalledTimes(2);
});

test('a refused action emits tab:approval_required for plugins', async () => {
  const tabId = 'event-tab';
  const fake = makeSession(tabId, { refs: { e1: { role: 'button', name: 'Publish' } } });
  __testing.sessions.set('agent', fake.session);
  const seen = [];
  __testing.pluginEvents.on('tab:approval_required', payload => seen.push(payload));

  await request(`/tabs/${tabId}/click`, { body: { userId: 'agent', ref: 'e1' } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ userId: 'agent', tabId, category: 'publish', element: 'Publish', domain: 'www.linkedin.com', ref: 'e1', source: 'element' });
});
