import assert from 'node:assert/strict';

/**
 * Core browser benchmark.
 *
 * Scope is deliberately narrow: public REST behavior that should be stable,
 * reproducible, and meaningful to any agent harness. No third-party sites,
 * credentials, CAPTCHA services, or network quality assumptions are involved.
 */
export const coreSuite = {
  id: 'core',
  version: 1,
  title: 'Goliath Core Browser Benchmark',
  cases: [
    {
      id: 'tab-create',
      title: 'Create a live browser tab',
      description: 'Creates a tab against a deterministic localhost fixture and verifies the returned browser handle.',
      async run({ client, fixtureUrl }) {
        const created = await client.createTab(fixtureUrl('/snapshot'));
        assert.ok(created.tabId, 'POST /tabs did not return tabId');
        assert.equal(typeof created.tabId, 'string', 'tabId must be a string');
        return { tabIdReturned: true };
      },
    },
    {
      id: 'snapshot-ref',
      title: 'Expose actionable accessibility refs',
      description: 'Reads the accessibility snapshot and verifies that a visible control receives an agent-targetable ref.',
      async run({ client, fixtureUrl }) {
        const { tabId } = await client.createTab(fixtureUrl('/snapshot'));
        const response = await client.snapshot(tabId);
        const text = snapshotText(response);
        assert.match(text, /goliath-benchmark-snapshot/i, 'snapshot omitted stable page content');
        const ref = findRef(text, 'Increment counter');
        assert.ok(ref, 'snapshot did not expose a ref for Increment counter');
        return { refFound: true };
      },
    },
    {
      id: 'ref-click',
      title: 'Act through a snapshot ref',
      description: 'Discovers a control through the snapshot, clicks it by ref, and verifies the page-side effect.',
      async run({ client, fixtureUrl }) {
        const { tabId } = await client.createTab(fixtureUrl('/snapshot'));
        const snapshot = snapshotText(await client.snapshot(tabId));
        const ref = findRef(snapshot, 'Increment counter');
        assert.ok(ref, 'could not resolve Increment counter ref');

        await client.click(tabId, { ref });
        const state = await client.evaluate(tabId, 'window.__count');
        assert.equal(state.result, 1, 'ref click did not increment the fixture counter');
        return { interaction: 'snapshot -> ref -> click -> verify' };
      },
    },
    {
      id: 'hands-form',
      title: 'Complete a multi-step form with Hands',
      description: 'Fills text fields, selects an option, submits once, and verifies the exact structured result.',
      async run({ client, fixtureUrl }) {
        const { tabId } = await client.createTab(fixtureUrl('/form'));
        const response = await client.hands(tabId, [
          { action: 'type', selector: '#first-name', text: 'Ada' },
          { action: 'type', selector: '#last-name', text: 'Lovelace' },
          { action: 'select', selector: '#country', value: 'LI' },
          { action: 'click', selector: '#submit' },
        ]);

        assert.equal(response.ok, true, 'hands request reported failure');
        assert.equal(response.completed, 4, 'hands did not complete all four steps');

        const state = await client.evaluate(tabId, 'window.__formResult');
        assert.deepEqual(state.result, {
          firstName: 'Ada',
          lastName: 'Lovelace',
          country: 'LI',
        });
        return { completedSteps: response.completed };
      },
    },
    {
      id: 'navigation',
      title: 'Navigate and observe the next document',
      description: 'Navigates an existing tab and verifies that a fresh snapshot reflects the destination document.',
      async run({ client, fixtureUrl }) {
        const { tabId } = await client.createTab(fixtureUrl('/navigation'));
        await client.navigate(tabId, fixtureUrl('/destination'));
        const snapshot = snapshotText(await client.snapshot(tabId));
        assert.match(snapshot, /goliath-benchmark-destination/i, 'fresh snapshot did not reflect destination page');
        return { destinationObserved: true };
      },
    },
    {
      id: 'multi-tab',
      title: 'Track multiple tabs in one session',
      description: 'Creates two tabs under one user/session and verifies both are visible through the public tab listing.',
      async run({ client, fixtureUrl }) {
        const first = await client.createTab(fixtureUrl('/snapshot'));
        const second = await client.createTab(fixtureUrl('/form'));
        const listed = await client.listTabs();
        const tabs = Array.isArray(listed) ? listed : listed.tabs;
        assert.ok(Array.isArray(tabs), 'GET /tabs did not return a tab collection');
        const ids = new Set(tabs.map(tab => tab.tabId || tab.id));
        assert.ok(ids.has(first.tabId), 'first tab missing from tab listing');
        assert.ok(ids.has(second.tabId), 'second tab missing from tab listing');
        return { tabsObserved: 2 };
      },
    },
    {
      id: 'session-state',
      title: 'Preserve origin state across tabs',
      description: 'Writes localStorage, closes the tab, reopens the same origin under the same browser identity, and verifies continuity.',
      async run({ client, fixtureUrl }) {
        const first = await client.createTab(fixtureUrl('/state'));
        const write = await client.evaluate(first.tabId, `(() => {
          localStorage.setItem('goliath-benchmark-token', 'state-survived');
          return localStorage.getItem('goliath-benchmark-token');
        })()`);
        assert.equal(write.result, 'state-survived', 'fixture could not write localStorage');

        await client.closeTab(first.tabId);
        const second = await client.createTab(fixtureUrl('/state'));
        const read = await client.evaluate(second.tabId, "localStorage.getItem('goliath-benchmark-token')");
        assert.equal(read.result, 'state-survived', 'browser identity did not preserve origin state across tabs');
        return { localStorageContinuity: true };
      },
    },
    {
      id: 'dynamic-control',
      title: 'Handle an asynchronously available control',
      description: 'Uses a bounded Hands wait before acting on a control inserted by client-side JavaScript.',
      async run({ client, fixtureUrl }) {
        const { tabId } = await client.createTab(fixtureUrl('/dynamic'));
        const response = await client.hands(tabId, [
          { action: 'wait', ms: 180 },
          { action: 'click', selector: '#delayed-action' },
        ]);
        assert.equal(response.ok, true, 'hands request failed on delayed control');

        const state = await client.evaluate(tabId, 'window.__dynamicClicked');
        assert.equal(state.result, true, 'delayed control was not activated');
        return { asynchronousInteraction: true };
      },
    },
  ],
};

function snapshotText(response) {
  if (typeof response === 'string') return response;
  for (const key of ['snapshot', 'content', 'text', 'tree']) {
    if (typeof response?.[key] === 'string') return response[key];
  }
  return JSON.stringify(response);
}

function findRef(snapshot, accessibleName) {
  const escaped = accessibleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    // Current snapshot format: - button "Accessible name" [e1]
    new RegExp(`(?:^|\\n)\\s*-\\s+[^\\n]*?"${escaped}"\\s+\\[(e\\d+)\\]`, 'i'),
    // Forward-compatible fallback if surrounding snapshot formatting changes.
    new RegExp(`${escaped}[^\\n]*\\b(e\\d+)\\b`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = snapshot.match(pattern);
    if (match) return match[1];
  }
  return null;
}
