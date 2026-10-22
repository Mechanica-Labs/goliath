import { test, expect, jest } from '@jest/globals';
import { askBrowserDecisions, prepareBrowserAssistance, validateDecisionAnswers, groundBrowserAnswers } from '../../lib/browser-decisions.js';
import { buildRequest } from '../../mcp/tool-contracts.mjs';
import { loadConfig } from '../../lib/config.js';

const config = { typesafeApiKey: 'test-jev', subqApiKey: 'test-subq' };
const questions = { visible: { type: 'noul', instructions: 'Is a red button visible?' } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const response = (answers = { visible: { type: 'noul', noul: 0.99 } }, model = 'model-test') =>
  new Response(JSON.stringify({ model, answers }));
const snapshot = {
  snapshotId: 'snap-1', stateHash: 'state-1', nodes: [
    { id: 'n1', ref: 'e1', role: 'link', name: 'Pricing', provenance: { snapshotId: 'snap-1', nodeId: 'n1' } },
    { id: 'n2', ref: null, role: 'text', name: '$20', provenance: { snapshotId: 'snap-1', nodeId: 'n2' } },
  ],
};

test.each(['jev', 'subq'])('%s sends image bytes to its own documented host only', async provider => {
  const mock = jest.fn(async () => response());
  const result = await askBrowserDecisions({ provider, config, state: { task: 'Look' }, questions, image: png, fetchImpl: mock });
  const [url, options] = mock.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(url).toBe(provider === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.subq.ai/v1/systemone');
  expect(options.redirect).toBe('error');
  expect(options.headers.Authorization).toBe(`Bearer ${provider === 'jev' ? config.typesafeApiKey : config.subqApiKey}`);
  if (provider === 'jev') {
    expect(body.model).toBe('jev-1.14.0');
    expect(options.headers['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(body.assets[body.state.screenshot]).toEqual({ type: 'image', format: 'png', data_base64: png.toString('base64') });
    expect(body.images).toBeUndefined();
  } else {
    expect(body.model).toBe('subq-snap-preview');
    expect(body.images).toEqual([{ mediaType: 'image/png', base64: png.toString('base64') }]);
    expect(body.assets).toBeUndefined();
  }
  expect(result.answers.visible.noul).toBe(0.99);
  expect(JSON.stringify(result)).not.toContain('test-jev');
});

test('text requests never contain image assets or the experimental header', async () => {
  const mock = jest.fn(async () => response());
  await askBrowserDecisions({ provider: 'jev', config, state: 'text', questions, fetchImpl: mock });
  const [, options] = mock.mock.calls[0];
  expect(options.headers['TypeSafe-Danger-Zone-Images']).toBeUndefined();
  expect(JSON.parse(options.body)).toEqual({ model: 'jev-1.14.0', state: 'text', questions });
});

test('missing credentials and unsupported box requests fail before network access', async () => {
  const mock = jest.fn();
  await expect(askBrowserDecisions({ provider: 'jev', config: {}, state: '', questions, fetchImpl: mock })).rejects.toMatchObject({ status: 503 });
  await expect(askBrowserDecisions({ provider: 'subq', config, state: '', questions: { target: { type: 'box', instructions: 'Find the button' } }, image: png, fetchImpl: mock })).rejects.toMatchObject({ status: 400 });
  expect(mock).not.toHaveBeenCalled();
});

test('Jev accepts a valid box and rejects inverted or non-finite geometry', async () => {
  const q = { target: { type: 'box', instructions: 'Find the button in screenshot' } };
  const valid = { target: { type: 'box', confidence: 0.9, box: { left: 0.1, right: 0.5, top: 0.2, bottom: 0.6 } } };
  expect(validateDecisionAnswers(valid, q)).toEqual(valid);
  for (const bad of [{ left: 0.7 }, { top: NaN }, { right: Infinity }, { bottom: 1.1 }]) {
    expect(() => validateDecisionAnswers({ target: { ...valid.target, box: { ...valid.target.box, ...bad } } }, q)).toThrow('invalid decision');
  }
});

test.each([undefined, NaN, Infinity, -0.1, 1.1, '0.9'])('rejects invalid probability %s', noul => {
  expect(() => validateDecisionAnswers({ visible: { type: 'noul', noul } }, questions)).toThrow('invalid decision');
});

test('ref selection returns only original observed text and provenance', () => {
  const prepared = prepareBrowserAssistance({ provider: 'subq', mode: 'select', goal: 'Find pricing' }, snapshot);
  expect(Object.keys(prepared.questions.target.criteria)).toEqual(['c0', 'none']);
  const answers = { target: { type: 'choice', choice: 'c0', confidence: 0.95, probabilities: { c0: 0.99, none: 0.01 } } };
  const result = groundBrowserAnswers({ answers }, prepared.candidates, snapshot);
  expect(result.selections.target).toMatchObject({ status: 'matched', nodeId: 'n1', ref: 'e1', value: 'Pricing', provenance: snapshot.nodes[0].provenance });
  answers.target.confidence = 0.7;
  expect(groundBrowserAnswers({ answers }, prepared.candidates, snapshot).selections.target).toMatchObject({ status: 'uncertain', ref: null, value: null });
});

test('field extraction can select observed text nodes without generating values', () => {
  const prepared = prepareBrowserAssistance({ provider: 'jev', mode: 'extract', goal: 'Read pricing', fields: { price: 'Monthly amount' } }, snapshot);
  expect(prepared.questions.price.criteria.c1).toBe('text: $20');
});

test('no-match stays distinct from an uncertain selected candidate', () => {
  const result = groundBrowserAnswers({ answers: { target: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { c0: 0.01, none: 0.99 } } } }, snapshot.nodes, snapshot);
  expect(result.selections.target).toMatchObject({ status: 'no_match', value: null });
});

test('unknown choices, incomplete distributions and unsupported answers fail closed', () => {
  const q = { x: { type: 'choice', criteria: { c0: 'Pricing', none: 'No match' }, instructions: 'Select' } };
  const a = { x: { type: 'choice', choice: 'c0', confidence: 0.9, probabilities: { c0: 0.99, none: 0.01 } } };
  expect(validateDecisionAnswers(a, q)).toEqual(a);
  expect(() => validateDecisionAnswers({ x: { ...a.x, choice: 'invented' } }, q)).toThrow();
  expect(() => validateDecisionAnswers({ x: { ...a.x, probabilities: { c0: 0.1, none: 0.1 } } }, q)).toThrow();
  expect(() => validateDecisionAnswers({ x: { ...a.x, probabilities: { c0: 0.99 } } }, q)).toThrow();
});

test('enforces screenshot consent, candidate budgets, field and image limits', async () => {
  expect(() => prepareBrowserAssistance({ provider: 'jev', mode: 'vision', questions }, snapshot)).toThrow('screenshot: true');
  expect(() => prepareBrowserAssistance({ provider: 'jev', mode: 'select', goal: 'pricing' }, { nodes: Array(129).fill(snapshot.nodes[0]) })).toThrow('128');
  expect(() => prepareBrowserAssistance({ provider: 'jev', mode: 'extract', goal: 'pricing', fields: {} }, snapshot)).toThrow('fields');
  await expect(askBrowserDecisions({ provider: 'jev', config, state: '', questions, image: Buffer.alloc(4 * 1024 * 1024 + 1) })).rejects.toMatchObject({ status: 400 });
});

test.each([401, 429, 500])('upstream HTTP %s errors never echo response bodies', async status => {
  const mock = jest.fn(async () => new Response('secret upstream body', { status }));
  await expect(askBrowserDecisions({ provider: 'jev', config, state: '', questions, fetchImpl: mock })).rejects.toThrow(`HTTP ${status}`);
});

test('network errors and malformed responses do not expose upstream content', async () => {
  for (const mock of [async () => { throw new Error('secret'); }, async () => new Response('secret')]) {
    await expect(askBrowserDecisions({ provider: 'jev', config, state: '', questions, fetchImpl: mock })).rejects.toThrow('jev request failed or timed out');
  }
  await expect(askBrowserDecisions({ provider: 'jev', config, state: '', questions, fetchImpl: async () => new Response('x'.repeat(262145)) })).rejects.toThrow('256 KiB');
});

test('MCP assistance binds the configured user and escapes tab IDs', () => {
  expect(buildRequest('goliath_assist', { tabId: 'tab/a', provider: 'subq', mode: 'select', goal: 'Pricing' }, { userId: 'agent-1' })).toMatchObject({
    path: '/tabs/tab%2Fa/assist', body: { userId: 'agent-1', provider: 'subq', mode: 'select' },
  });
});

test('provider credentials are forwarded into the managed server without mixing keys', () => {
  const old = { ...process.env };
  try {
    process.env.TYPESAFE_API_KEY = 'jev-test'; process.env.SUBQ_API_KEY = 'subq-test';
    const loaded = loadConfig();
    expect(loaded.typesafeApiKey).toBe('jev-test');
    expect(loaded.subqApiKey).toBe('subq-test');
    expect(loaded.serverEnv.TYPESAFE_API_KEY).toBe('jev-test');
    expect(loaded.serverEnv.SUBQ_API_KEY).toBe('subq-test');
  } finally { process.env = old; }
});
