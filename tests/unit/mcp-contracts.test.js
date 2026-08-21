import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@jest/globals';

import { TOOL_DEFS, TOOL_NAMES, buildRequest } from '../../mcp/tool-contracts.mjs';

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
