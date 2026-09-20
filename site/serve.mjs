import { createServer } from 'node:http';
import { readFile, realpath, stat, access, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

// This entry point has no configurable document root, bind address, or port.
const root = await realpath(fileURLToPath(new URL('.', import.meta.url)));
const origin = 'http://127.0.0.1:8801';
const tunnelMode = process.argv.length === 3 && process.argv[2] === '--tunnel';
if (process.argv.length > 2 && !tunnelMode) {
  console.error('Usage: node site/serve.mjs [--tunnel]');
  process.exit(2);
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return;
    }
    const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
    // No hidden files or directory listings, even inside the public folder.
    if (pathname.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden path');
    let path = await realpath(resolve(root, '.' + pathname));
    if (path !== root && !path.startsWith(root + sep)) throw new Error('Outside root');
    if ((await stat(path)).isDirectory()) path = await realpath(resolve(path, 'index.html'));
    if (!path.startsWith(root + sep)) throw new Error('Outside root');
    const type = types[extname(path)];
    if (!type) throw new Error('Unsupported file');
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
});

let tunnel, tunnelDirectory, startupTimer, forceTimer, stopping = false;
async function finish(code) {
  clearTimeout(forceTimer);
  if (tunnelDirectory) await rm(tunnelDirectory, { recursive: true, force: true });
  process.exitCode = code;
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  server.close();
  server.closeAllConnections();
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    tunnel.once('close', () => void finish(code));
    tunnel.kill('SIGTERM');
    forceTimer = setTimeout(() => tunnel.kill('SIGKILL'), 3000);
  } else {
    void finish(code);
  }
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
server.on('error', error => {
  console.error(`Site could not start: ${error.message}. No tunnel was opened.`);
  stop(1);
});

if (tunnelMode) {
  // With the exact quick-tunnel command below, reject ambient ingress config
  // rather than risk inheriting routes to a different local service.
  const directories = [join(homedir(), '.cloudflared'), join(homedir(), '.cloudflare-warp'), join(homedir(), 'cloudflare-warp'), '/etc/cloudflared', '/usr/local/etc/cloudflared'];
  for (const directory of directories) {
    for (const name of ['config.yml', 'config.yaml']) {
      const path = join(directory, name);
      try { await access(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`Existing cloudflared config at ${path}; use an unconfigured account for this site-only quick tunnel. No files were changed.`);
    }
  }
  tunnelDirectory = await mkdtemp(join(tmpdir(), 'goliath-site-tunnel-'));
}
server.listen(8801, '127.0.0.1', () => {
  console.log(`Site: ${origin}`);
  if (!tunnelMode || stopping) return;
  // Ignore inherited tunnel options. The origin and arguments are fixed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TUNNEL_')));
  tunnel = spawn('cloudflared', ['tunnel', '--url', origin, '--no-autoupdate', '--logfile', '-'], {
    cwd: tunnelDirectory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let announced = false;
  const inspect = line => {
    process.stderr.write(line + '\n');
    const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|"'<>]|$)/i)?.[0];
    if (url && !announced) {
      announced = true;
      clearTimeout(startupTimer);
      console.log(`Public site: ${url}`);
      console.log('This quick-tunnel URL changes each run. Press Ctrl+C to stop.');
    }
  };
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) inspect(line);
      if (pending.length > 32768) pending = pending.slice(-32768);
    });
    stream.on('end', () => { if (pending) inspect(pending); });
  }
  startupTimer = setTimeout(() => {
    console.error('No quick-tunnel URL appeared within 60 seconds; stopping.');
    stop(1);
  }, 60000);
  tunnel.on('error', error => {
    console.error(`Tunnel could not start: ${error.message}`);
    stop(1);
  });
  tunnel.on('close', (code, signal) => {
    if (stopping) return;
    console.error(`Tunnel stopped (${signal || code}); closing the site server.`);
    stop(code || 1);
  });
});
