import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@jest/globals';

import { TOOL_DEFS, TOOL_NAMES, adaptResponse, buildRequest } from '../../mcp/tool-contracts.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

test('MCP and OpenClaw advertise the same Goliath tools', () => {
  expect([...TOOL_NAMES].sort()).toEqual(manifest.openclaw.tools.map((tool) => tool.name).sort());
  expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  expect(TOOL_DEFS.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
});

test('MCP action, hand, and upload requests preserve the agent identity', () => {
  const context = { userId: 'agent-1', sessionKey: 'task-1' };
  expect(buildRequest('goliath_act', { tabId: 'tab/a', kind: 'press', key: 'Enter' }, context)).toMatchObject({
    method: 'POST',
    path: '/act',
    body: { targetId: 'tab/a', kind: 'press', key: 'Enter', userId: 'agent-1' },
  });
  expect(buildRequest('goliath_upload', { tabId: 'tab/a', path: '/safe/file.pdf' }, context)).toMatchObject({
    method: 'POST',
    path: '/tabs/tab%2Fa/upload',
    body: { path: '/safe/file.pdf', userId: 'agent-1' },
  });
  expect(buildRequest('goliath_hands', {
    tabId: 'tab/a',
    steps: [{ action: 'type', ref: 'e1', text: 'Carlos' }],
  }, context)).toMatchObject({
    method: 'POST',
    path: '/tabs/tab%2Fa/hands',
    body: {
      steps: [{ action: 'type', ref: 'e1', text: 'Carlos' }],
      userId: 'agent-1',
    },
  });
});

test('MCP tab creation uses a stable user and session partition', () => {
  const request = buildRequest(
    'goliath_create_tab',
    { url: 'https://example.com' },
    { userId: 'personal-assistant', sessionKey: 'certificate-course' }
  );
  expect(request.body).toEqual({
    url: 'https://example.com',
    userId: 'personal-assistant',
    sessionKey: 'certificate-course',
  });
});

test('MCP semantic requests preserve snapshot and session boundaries', () => {
  const context = { userId: 'agent/one', sessionKey: 'task-1' };
  expect(buildRequest('goliath_plan_action', {
    tabId: 'tab/a',
    snapshotId: 'snapshot-1',
    nodeId: 'node-1',
    kind: 'click',
    allowedOrigins: ['https://example.com'],
  }, context)).toMatchObject({
    method: 'POST',
    path: '/tabs/tab%2Fa/actions/plan',
    body: {
      userId: 'agent/one',
      snapshotId: 'snapshot-1',
      action: { nodeId: 'node-1', kind: 'click' },
      policy: { allowedOrigins: ['https://example.com'] },
    },
  });
  expect(buildRequest('goliath_checkpoint', { checkpointId: 'before-submit' }, context)).toEqual({
    method: 'POST',
    path: '/sessions/agent%2Fone/checkpoints',
    responseKind: 'json',
    body: { checkpointId: 'before-submit' },
  });
  expect(buildRequest('goliath_fork', {
    checkpointId: 'before-submit',
    newUserId: 'branch-user',
  }, context)).toMatchObject({
    method: 'POST',
    path: '/sessions/agent%2Fone/forks',
    body: { checkpointId: 'before-submit', newUserId: 'branch-user' },
  });
});

test('MCP screenshot path is forwarded to REST as JSON metadata', () => {
  const request = buildRequest(
    'goliath_screenshot',
    { tabId: 'tab/a', fullPage: true, path: 'shots/page.png' },
    { userId: 'agent-1', sessionKey: 'task-1' },
  );
  expect(request).toEqual({
    method: 'GET',
    path: '/tabs/tab%2Fa/screenshot?userId=agent-1&fullPage=true&path=shots%2Fpage.png',
    responseKind: 'json',
  });
});

test('MCP screenshot without path still requests image bytes', () => {
  const request = buildRequest(
    'goliath_screenshot',
    { tabId: 'tab/a' },
    { userId: 'agent-1', sessionKey: 'task-1' },
  );
  expect(request).toEqual({
    method: 'GET',
    path: '/tabs/tab%2Fa/screenshot?userId=agent-1',
    responseKind: 'image',
  });
});

test('MCP click, type, and hands forward the dangerous-action confirm flag unchanged', () => {
  const context = { userId: 'agent-1', sessionKey: 'task-1' };
  expect(buildRequest('goliath_click', { tabId: 'tab/a', ref: 'e1', confirm: true }, context)).toMatchObject({
    path: '/tabs/tab%2Fa/click',
    body: { ref: 'e1', confirm: true, userId: 'agent-1' },
  });
  expect(buildRequest('goliath_type', { tabId: 'tab/a', ref: 'e1', text: 'hi', pressEnter: true, confirm: true }, context)).toMatchObject({
    path: '/tabs/tab%2Fa/type',
    body: { ref: 'e1', text: 'hi', pressEnter: true, confirm: true, userId: 'agent-1' },
  });
  expect(buildRequest('goliath_hands', {
    tabId: 'tab/a',
    steps: [{ action: 'click', ref: 'e3', confirm: true }],
  }, context)).toMatchObject({
    path: '/tabs/tab%2Fa/hands',
    body: { steps: [{ action: 'click', ref: 'e3', confirm: true }], userId: 'agent-1' },
  });
  expect(buildRequest('goliath_act', { tabId: 'tab/a', kind: 'press', key: 'Enter', confirm: true }, context)).toMatchObject({
    path: '/act',
    body: { targetId: 'tab/a', kind: 'press', key: 'Enter', confirm: true, userId: 'agent-1' },
  });
  for (const name of ['goliath_click', 'goliath_type', 'goliath_act']) {
    const tool = TOOL_DEFS.find((entry) => entry.name === name);
    expect(tool.inputSchema.properties.confirm).toMatchObject({ type: 'boolean' });
  }
  const hands = TOOL_DEFS.find((entry) => entry.name === 'goliath_hands');
  expect(hands.inputSchema.properties.confirm).toBeUndefined(); // approvals are per step, never per hand
  expect(hands.inputSchema.properties.steps.items.properties.confirm).toMatchObject({ type: 'boolean' });
  // The bridge passes a refusal through verbatim as a normal text result, never as an error.
  const spec = buildRequest('goliath_click', { tabId: 'tab/a', ref: 'e1' }, context);
  const refusal = { ok: false, status: 'approval_required', category: 'send', hint: 'ask' };
  expect(JSON.parse(adaptResponse(spec, refusal)[0].text)).toEqual(refusal);
});
