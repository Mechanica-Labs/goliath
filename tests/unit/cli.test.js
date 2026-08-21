import { test, expect } from '@jest/globals';

import { harnessConfigs } from '../../lib/cli.js';

test('setup emits pinned JSON and Hermes MCP configurations', () => {
  const config = harnessConfigs('9.8.7');
  expect(config.json.mcpServers.goliath).toEqual({
    command: 'npx',
    args: ['-y', '@mechanica-labs/goliath@9.8.7', 'mcp'],
    env: { GOLIATH_USER_ID: 'my-agent' },
  });
  expect(config.hermes).toContain('mcp_servers:');
  expect(config.hermes).toContain('@mechanica-labs/goliath@9.8.7');
});
