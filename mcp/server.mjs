#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from '../lib/config.js';
import { ensureBrowserInstalled } from '../lib/browser-install.js';
import { launchServer } from '../lib/launcher.js';
import { TOOL_DEFS, adaptResponse, runTool } from './tool-contracts.mjs';

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(MCP_DIR, '..');
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
const CONFIG = loadConfig();
const BASE_URL = CONFIG.mcpBaseUrl || `http://127.0.0.1:${CONFIG.port}`;
const CALL_CONTEXT = { userId: CONFIG.mcpUserId, sessionKey: CONFIG.mcpSessionKey };

let managedServer = null;
let shuttingDown = false;

function log(message) {
  process.stderr.write(`[goliath-mcp] ${message}\n`);
}

async function healthCheck() {
  try {
    const headers = CONFIG.accessKey ? { Authorization: `Bearer ${CONFIG.accessKey}` } : {};
    const response = await fetch(`${BASE_URL}/health`, {
      headers,
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isLocalBaseUrl() {
  try {
    const host = new URL(BASE_URL).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function ensureRestServer() {
  if (await healthCheck()) {
    log(`attached to ${BASE_URL} as ${CALL_CONTEXT.userId}`);
    return;
  }
  if (!CONFIG.mcpAutoStart) {
    throw new Error(`REST server is not reachable at ${BASE_URL} and GOLIATH_MCP_AUTO_START is disabled`);
  }
  if (!isLocalBaseUrl()) {
    throw new Error(`refusing to auto-start a local server for non-loopback GOLIATH_BASE_URL: ${BASE_URL}`);
  }

  const url = new URL(BASE_URL);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  await ensureBrowserInstalled(CONFIG, { stdout: process.stderr, stderr: process.stderr });
  log(`starting local browser server at ${BASE_URL}`);
  managedServer = launchServer({
    pluginDir: ROOT_DIR,
    port,
    env: {
      ...CONFIG.serverEnv,
      GOLIATH_WORKSPACE: CONFIG.workspaceDir || process.cwd(),
      GOLIATH_SCREENSHOTS_DIR: CONFIG.screenshotsDir,
    },
    log: {
      info: (message) => log(message),
      error: (message) => log(message),
    },
  });

  const deadline = Date.now() + CONFIG.mcpStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (managedServer.exitCode != null) {
      throw new Error(`local REST server exited with code ${managedServer.exitCode}`);
    }
    if (await healthCheck()) {
      log(`local browser server ready; agent identity=${CALL_CONTEXT.userId}`);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  managedServer.kill('SIGTERM');
  managedServer = null;
  throw new Error(`local REST server did not become ready within ${CONFIG.mcpStartupTimeoutMs}ms`);
}

const server = new McpServer(
  { name: 'goliath', version: PACKAGE.version },
  { capabilities: { tools: {} } }
);

for (const tool of TOOL_DEFS) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: fromJsonSchema(tool.inputSchema),
    },
    async (args) => {
      try {
        const { spec, payload } = await runTool(tool.name, args || {}, CALL_CONTEXT, BASE_URL, CONFIG);
        return { content: adaptResponse(spec, payload) };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }
  );
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (managedServer && managedServer.exitCode == null) {
    try {
      const headers = CONFIG.accessKey ? { Authorization: `Bearer ${CONFIG.accessKey}` } : {};
      await fetch(`${BASE_URL}/sessions/${encodeURIComponent(CALL_CONTEXT.userId)}`, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      log(`session checkpoint before shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    log(`stopping managed browser server (${signal})`);
    managedServer.kill('SIGTERM');
  }
  try {
    await server.close();
  } catch {
    // Transport may already be closed by the host.
  }
}

process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.stdin.once('end', () => shutdown('stdin closed'));
process.once('exit', () => {
  if (managedServer && managedServer.exitCode == null) managedServer.kill('SIGTERM');
});

try {
  await ensureRestServer();
  await server.connect(new StdioServerTransport());
  log(`MCP ${PACKAGE.version} ready with ${TOOL_DEFS.length} tools`);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  if (managedServer && managedServer.exitCode == null) managedServer.kill('SIGTERM');
  process.exit(1);
}
