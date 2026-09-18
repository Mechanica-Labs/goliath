import { expect, test, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEgressRegistry, normalizeEgressProfiles, renderMatrix } from '../../lib/egress-profile.js';

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goliath-egress-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const PROFILES = [
  { name: 'dc-frankfurt', class: 'datacenter', server: 'dc.example.com:8000' },
  { name: 'res-dubai', class: 'residential', server: 'res.example.com:9000', country: 'AE' },
  { name: 'mobile-ae', class: 'mobile', server: 'mob.example.com:9100' },
];

test('normalizes profiles from an array or a JSON string and drops unusable entries', () => {
  expect(normalizeEgressProfiles(PROFILES).map(p => p.class)).toEqual(['datacenter', 'residential', 'mobile']);
  expect(normalizeEgressProfiles(JSON.stringify(PROFILES))).toHaveLength(3);
  expect(normalizeEgressProfiles([{ name: 'x', class: 'satellite' }])[0].class).toBe('unknown');
  expect(normalizeEgressProfiles([{ class: 'residential' }, null, 'nope', { name: 'dup' }, { name: 'dup' }])).toHaveLength(1);
  expect(normalizeEgressProfiles('{not json')).toEqual([]);
});

test('records outcomes per vendor and persists them', () => {
  const dir = tmpDir();
  const registry = createEgressRegistry({ profiles: PROFILES, stateDir: dir });
  registry.record('dc-frankfurt', 'perimeterx', 'blocked');
  registry.record('dc-frankfurt', 'perimeterx', 'blocked');
  registry.record('res-dubai', 'perimeterx', 'cleared');

  const reloaded = createEgressRegistry({ profiles: PROFILES, stateDir: dir });
  expect(reloaded.outcomesFor('dc-frankfurt', 'perimeterx').blocked).toBe(2);
  expect(reloaded.outcomesFor('res-dubai', 'PerimeterX').cleared).toBe(1);
  expect(fs.existsSync(path.join(dir, 'egress-profiles.json'))).toBe(true);
});

test('prefers a profile with a recorded clear, then a better network class', () => {
  const registry = createEgressRegistry({ profiles: PROFILES, stateDir: tmpDir() });
  registry.record('dc-frankfurt', 'perimeterx', 'blocked');
  registry.record('dc-frankfurt', 'perimeterx', 'blocked');
  // No history yet: the better network class wins (residential, then mobile).
  expect(registry.nextFor('perimeterx', 'dc-frankfurt').name).toBe('res-dubai');
  registry.record('mobile-ae', 'perimeterx', 'cleared');
  expect(registry.nextFor('perimeterx', 'dc-frankfurt').name).toBe('mobile-ae');
  expect(registry.deadEndsFor('perimeterx')).toEqual(['dc-frankfurt']);
});

test('never re-picks the current profile or an explicitly skipped one', () => {
  const registry = createEgressRegistry({ profiles: PROFILES, stateDir: tmpDir() });
  expect(registry.nextFor('perimeterx', 'dc-frankfurt').name).not.toBe('dc-frankfurt');
  expect(registry.nextFor('perimeterx', 'dc-frankfurt', { skip: ['res-dubai', 'mobile-ae'] })).toBeNull();
});

test('a single-profile fleet reports no alternative instead of inventing one', () => {
  const registry = createEgressRegistry({ profiles: [PROFILES[0]], stateDir: tmpDir() });
  expect(registry.nextFor('perimeterx', 'dc-frankfurt')).toBeNull();
});

test('renders the network-class matrix for documentation', () => {
  const registry = createEgressRegistry({ profiles: PROFILES, stateDir: tmpDir() });
  registry.record('res-dubai', 'perimeterx', 'cleared');
  const markdown = renderMatrix(registry);
  expect(markdown).toContain('| Profile | Class | perimeterx |');
  expect(markdown).toContain('| res-dubai | residential | 1 cleared (cleared) |');
  expect(markdown).toContain('| dc-frankfurt | datacenter | untested |');
});
