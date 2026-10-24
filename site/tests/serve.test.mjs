import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

const origin = 'http://127.0.0.1:8801';
async function fixture(t, mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'goliath-tunnel-test-'));
  const site = join(root, 'site'), bin = join(root, 'bin');
  await mkdir(site); await mkdir(bin);
  for (const file of ['serve.sh', 'serve.mjs']) await copyFile(new URL('../' + file, import.meta.url), join(site, file));
  await writeFile(join(site, 'index.html'), '<h1>Public site fixture</h1>');
  await writeFile(join(root, 'private.json'), 'PRIVATE OUTSIDE SITE');
  await symlink(join(root, 'private.json'), join(site, 'escape.json'));
  await writeFile(join(site, '.hidden.json'), 'PRIVATE HIDDEN FILE');
  const evidence = join(root, 'invocation.json');
  await writeFile(join(bin, 'cloudflared'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({args:process.argv.slice(2),pid:process.pid,cwd:process.cwd(),inherited:process.env.TUNNEL_URL}));
if (${JSON.stringify(mode)} === 'failure') { console.error('Test tunnel failure'); process.exit(7); }
process.stderr.write('Test log: https://fixture-only.');
setTimeout(() => process.stderr.write('trycloudflare.com |\\n'), 10);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const child = spawn('bash', [join(site, 'serve.sh')], { cwd: root, env: { ...process.env, PATH: bin + ':' + process.env.PATH, TUNNEL_URL: 'http://unrelated.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  return { child, closed, site, evidence, output: () => ({ stdout, stderr }) };
}
async function waitForOutput(child, text, output) {
  if (output().stdout.includes(text)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Timed out: ' + JSON.stringify(output()))), 5000);
    const check = () => { if (output().stdout.includes(text)) done(); };
    const exited = () => done(new Error('Early exit: ' + JSON.stringify(output())));
    function done(error) {
      clearTimeout(timer); child.stdout.off('data', check); child.off('close', exited);
      error ? reject(error) : resolve();
    }
    child.stdout.on('data', check); child.once('close', exited);
  });
}

test('site-only origin, exact tunnel arguments, split-log URL extraction, and signal cleanup', { timeout: 10000 }, async t => {
  const run = await fixture(t);
  await waitForOutput(run.child, 'Public site:', run.output);
  assert.match(run.output().stdout, /Public site: https:\/\/fixture-only\.trycloudflare\.com/);
  const invocation = JSON.parse(await readFile(run.evidence, 'utf8'));
  assert.deepEqual(invocation.args, ['tunnel', '--url', origin, '--no-autoupdate', '--logfile', '-']);
  assert.equal(invocation.inherited, undefined);
  assert.ok(!invocation.cwd.startsWith(run.site));
  assert.match(await (await fetch(origin)).text(), /Public site fixture/);
  for (const path of ['/private.json', '/escape.json', '/.hidden.json', '/gateway', '/dashboard', '/%2e%2e%2fprivate.json']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  // A second listener on a real LAN interface rules out a wildcard bind.
  const lan = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal);
  if (lan) {
    const other = createServer(); other.listen(8801, lan.address); await once(other, 'listening');
    await new Promise(resolve => other.close(resolve));
  } else {
    t.diagnostic('No LAN interface available for the independent wildcard-bind check.');
  }
  run.child.kill('SIGINT');
  assert.equal((await run.closed)[0], 130);
  assert.throws(() => process.kill(invocation.pid, 0), /ESRCH/);
  await assert.rejects(fetch(origin));
  await assert.rejects(readFile(join(invocation.cwd, '-')), /ENOENT/);
});

test('occupied port fails before invoking cloudflared', { timeout: 10000 }, async t => {
  const occupied = createServer(); occupied.listen(8801, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const run = await fixture(t);
  assert.equal((await run.closed)[0], 1);
  assert.match(run.output().stderr, /EADDRINUSE.*No tunnel was opened/);
  await assert.rejects(readFile(run.evidence), /ENOENT/);
});

test('tunnel failure closes the site and preserves its failure exit code', { timeout: 10000 }, async t => {
  const run = await fixture(t, 'failure');
  assert.equal((await run.closed)[0], 7);
  assert.match(run.output().stderr, /Test tunnel failure/);
  await assert.rejects(fetch(origin));
});
