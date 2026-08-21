#!/usr/bin/env node
/**
 * Sync runtime metadata versions with package.json.
 * Run via: npm run version:sync
 * Auto-runs on npm version via the "version" lifecycle script.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginPath = join(root, 'openclaw.plugin.json');
const plugin = JSON.parse(await readFile(pluginPath, 'utf8'));
const configPath = join(root, 'goliath.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));

if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  await writeFile(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
  console.log(`openclaw.plugin.json version synced to ${pkg.version}`);
} else {
  console.log(`openclaw.plugin.json already at ${pkg.version}`);
}

if (config.version !== pkg.version) {
  config.version = pkg.version;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`goliath.config.json version synced to ${pkg.version}`);
} else {
  console.log(`goliath.config.json already at ${pkg.version}`);
}

for (const relativePath of ['README.md', 'docs/HARNESS_SETUP.md']) {
  const path = join(root, relativePath);
  const current = await readFile(path, 'utf8');
  const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pinnedPackage = new RegExp(`${escapedName}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?`, 'g');
  const next = current.replace(pinnedPackage, `${pkg.name}@${pkg.version}`);
  if (next !== current) {
    await writeFile(path, next);
    console.log(`${relativePath} install examples synced to ${pkg.version}`);
  } else {
    console.log(`${relativePath} install examples already at ${pkg.version}`);
  }
}
