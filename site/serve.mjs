import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = await realpath(fileURLToPath(new URL('.', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const port = Number(process.env.CONDUCTOR_PORT || 0);
if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid CONDUCTOR_PORT');
const server = createServer(async (req, res) => {
    try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
        }
        const pathname = decodeURIComponent(new URL(req.url, 'http://preview.invalid').pathname);
        let path = await realpath(resolve(root, '.' + pathname));
        if (path !== root && !path.startsWith(root + sep))
            throw new Error('Outside root');
        if ((await stat(path)).isDirectory())
            path = await realpath(resolve(path, 'index.html'));
        if (!path.startsWith(root + sep))
            throw new Error('Outside root');
        const type = types[extname(path)];
        if (!type)
            throw new Error('Unsupported file');
        const bytes = await readFile(path);
        res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
});
server.listen(port, '0.0.0.0', () => console.log(`Preview: http://localhost:${server.address().port}`));
