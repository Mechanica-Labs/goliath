import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

test('public package metadata uses one version', () => {
  const packageMetadata = readJson('package.json');
  const packageVersion = packageMetadata.version;
  const escapedName = packageMetadata.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pinnedPackage = new RegExp(`${escapedName}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`, 'g');

  expect(readJson('openclaw.plugin.json').version).toBe(packageVersion);
  expect(readJson('goliath.config.json').version).toBe(packageVersion);
  for (const relativePath of ['README.md', 'docs/HARNESS_SETUP.md']) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const pinnedVersions = [...source.matchAll(pinnedPackage)]
      .map((match) => match[1]);
    expect(pinnedVersions.length).toBeGreaterThan(0);
    expect(new Set(pinnedVersions)).toEqual(new Set([packageVersion]));
  }
});
