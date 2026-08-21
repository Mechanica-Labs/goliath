import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../../mcp/tool-contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function textPayload(result, label) {
  const block = result?.content?.find((item) => item.type === 'text');
  if (!block) throw new Error(`${label} returned no text result`);
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function runHarnessSmoke({ environment = {}, spawnImpl = spawn, timeoutMs = 45_000 } = {}) {
  const port = await findFreePort();
  const child = spawnImpl(process.execPath, [resolve(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...environment,
      GOLIATH_PORT: String(port),
      GOLIATH_BASE_URL: `http://127.0.0.1:${port}`,
      GOLIATH_USER_ID: `harness-install-${process.pid}`,
      GOLIATH_SESSION_KEY: 'install-smoke',
      GOLIATH_MCP_AUTO_START: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  child.once('error', (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  child.once('exit', (code) => {
    if (code === 0 || pending.size === 0) return;
    const error = new Error(`MCP smoke process exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  function request(method, params = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP smoke timed out during ${method}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timeout });
    });
  }

  let tabId = null;
  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'goliath-harness-installer', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await request('tools/list');
    const names = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...TOOL_NAMES].sort())) {
      throw new Error('MCP smoke tool list differs from the public tool contract');
    }
    if (!names.includes('goliath_hands')) throw new Error('MCP smoke is missing the Hands tool');

    const created = textPayload(await request('tools/call', {
      name: 'goliath_create_tab',
      arguments: { url: 'https://example.com' },
    }), 'goliath_create_tab');
    tabId = created.tabId;
    if (!tabId) throw new Error('goliath_create_tab returned no tabId');

    const snapshot = textPayload(await request('tools/call', {
      name: 'goliath_snapshot',
      arguments: { tabId },
    }), 'goliath_snapshot');
    if (!String(snapshot.snapshot || '').includes('Example Domain')) {
      throw new Error('MCP browser smoke did not find Example Domain');
    }

    const hand = textPayload(await request('tools/call', {
      name: 'goliath_hands',
      arguments: { tabId, steps: [{ action: 'wait', ms: 10 }] },
    }), 'goliath_hands');
    if (!hand.completed) throw new Error('Hands smoke did not complete');
    return { ok: true, tools: names.length, hands: true, exampleDomain: true };
  } finally {
    if (tabId && child.exitCode == null) {
      try {
        await request('tools/call', { name: 'goliath_close_tab', arguments: { tabId } });
      } catch {
        // Best-effort cleanup only.
      }
    }
    child.stdin.end();
    setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGTERM');
    }, 2_000).unref();
    lines.close();
  }
}
