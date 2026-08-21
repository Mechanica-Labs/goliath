#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../mcp/tool-contracts.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.GOLIATH_MCP_TEST_PORT || 9477);
const child = spawn(process.execPath, ['mcp/server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    GOLIATH_PORT: String(port),
    GOLIATH_BASE_URL: `http://127.0.0.1:${port}`,
    GOLIATH_USER_ID: 'mcp-smoke',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolveRequest, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolveRequest(message.result);
    });
  });
}

function textPayload(result) {
  const block = result.content?.find((item) => item.type === 'text');
  if (!block) throw new Error('MCP tool result did not contain text');
  return JSON.parse(block.text);
}

try {
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'goliath-smoke', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const listed = await request('tools/list');
  const listedNames = listed.tools.map((tool) => tool.name).sort();
  const expectedNames = [...TOOL_NAMES].sort();
  if (JSON.stringify(listedNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Unexpected MCP tools: expected ${expectedNames.join(', ')}, received ${listedNames.join(', ')}`);
  }

  const created = textPayload(await request('tools/call', {
    name: 'goliath_create_tab',
    arguments: { url: 'https://example.com' },
  }));
  if (!created.tabId) throw new Error('create_tab did not return tabId');

  const snapshot = textPayload(await request('tools/call', {
    name: 'goliath_snapshot',
    arguments: { tabId: created.tabId },
  }));
  if (!String(snapshot.snapshot).includes('Example Domain')) {
    throw new Error('snapshot did not contain Example Domain');
  }

  const hand = textPayload(await request('tools/call', {
    name: 'goliath_hands',
    arguments: {
      tabId: created.tabId,
      steps: [
        { action: 'wait', ms: 10 },
        { action: 'scroll', direction: 'down', amount: 50 },
      ],
    },
  }));
  if (!hand.completed || hand.results?.length !== 2) {
    throw new Error('hands did not complete the two-step workflow');
  }

  await request('tools/call', {
    name: 'goliath_close_tab',
    arguments: { tabId: created.tabId },
  });
  process.stdout.write(`MCP smoke passed: ${listed.tools.length} tools, live create/snapshot/hands/close\n`);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 5000).unref();
}
