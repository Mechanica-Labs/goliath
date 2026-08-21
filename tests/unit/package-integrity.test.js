import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@jest/globals';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.js', '.ts'].includes(extname(entry.name)) ? [path] : [];
  });
}

test('package uses the published Camoufox runtime and ships its CLIs', () => {
  expect(manifest.dependencies['camoufox-js']).toBeDefined();
  expect(manifest.dependencies['goliath-js']).toBeUndefined();
  const cli = resolve(root, manifest.bin.goliath);
  expect(existsSync(cli)).toBe(true);
  expect(statSync(cli).mode & 0o111).not.toBe(0);
  const mcpCli = resolve(root, manifest.bin['goliath-mcp']);
  expect(existsSync(mcpCli)).toBe(true);
  expect(statSync(mcpCli).mode & 0o111).not.toBe(0);
  expect(manifest.dependencies['@modelcontextprotocol/server']).toBeDefined();
  expect(manifest.scripts.postinstall).toBeUndefined();
  expect(manifest.contentPolicy).toEqual({ class: 'dual-use' });
  expect(existsSync(resolve(root, 'DISCLOSURE'))).toBe(true);
  expect(manifest.files).toContain('DISCLOSURE');
});

test('Camoufox uses the MIT-licensed compatible UA parser release', () => {
  expect(manifest.overrides['camoufox-js']['ua-parser-js']).toBe('1.0.41');
  expect(lockfile.packages['node_modules/camoufox-js/node_modules/ua-parser-js']).toMatchObject({
    version: '1.0.41',
    license: 'MIT',
  });
  const requireFromCamoufox = createRequire(resolve(root, 'node_modules/camoufox-js/package.json'));
  const { UAParser } = requireFromCamoufox('ua-parser-js');
  const parser = new UAParser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0');
  expect(parser.getOS().name).toBe('Windows');
  expect(parser.getBrowser().name).toBe('Firefox');
});

test('locked packages contain no strong-copyleft or source-available licenses', () => {
  const restricted = Object.entries(lockfile.packages)
    .filter(([, pkg]) => /AGPL|GPL|SSPL|BUSL|Commons Clause/i.test(pkg.license || ''))
    .map(([path, pkg]) => ({ path, version: pkg.version, license: pkg.license }));
  expect(restricted).toEqual([]);
});

// The explicit installer is part of the public CLI. Every relative module it
// imports must therefore be present in the npm allowlist.
test('everything the explicit installer imports is packaged', () => {
  const source = readFileSync(resolve(root, 'scripts/install.js'), 'utf8');
  const imported = [...source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
  expect(imported.length).toBeGreaterThan(0);

  for (const specifier of imported) {
    const target = resolve(root, 'scripts', specifier);
    expect(existsSync(target)).toBe(true);

    const relative = target.slice(root.length + 1);
    const shipped = manifest.files.some((entry) => (
      entry.endsWith('/') ? relative.startsWith(entry) : relative === entry
    ));
    expect({ specifier, shipped }).toEqual({ specifier, shipped: true });
  }
});

test('all relative static imports resolve to packaged source files', () => {
  const missing = [];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      if (source.slice(lineStart, match.index).includes('*')) continue;
      const target = resolve(dirname(file), match[1]);
      const candidates = [target, `${target}.js`, `${target}.ts`, resolve(target, 'index.js')];
      if (!candidates.some(existsSync)) missing.push(`${file}: ${match[1]}`);
    }
  }
  expect(missing).toEqual([]);
});

test('generated API and documentation assets are present', () => {
  expect(existsSync(resolve(root, 'openapi.json'))).toBe(true);
  expect(existsSync(resolve(root, 'docs/api.html'))).toBe(true);
  expect(existsSync(resolve(root, 'assets/goliath-brand.svg'))).toBe(true);
  expect(existsSync(resolve(root, 'assets/README.md'))).toBe(true);
  expect(existsSync(resolve(root, 'assets/goliath-logo.jpg'))).toBe(true);
});

test('third-party notices identify the dependency licenses that affect redistribution', () => {
  const notice = readFileSync(resolve(root, 'NOTICE.md'), 'utf8');
  expect(manifest.files).toContain('NOTICE.md');
  expect(notice).toContain('camoufox-js 0.12.0');
  expect(notice).toContain('playwright-core 1.60.0');
  expect(notice).toContain('ua-parser-js 1.0.41');
  expect(notice).toContain('MPL-2.0');
  expect(notice).toContain('Apache-2.0');
  expect(notice).not.toContain('AGPL-3.0-or-later');
});
