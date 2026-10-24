import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const slugify = title => title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
export function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value;
}
export function textField(value, name, max = 10000) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f]/.test(value))
        throw new Error(`${name} must be nonempty text (maximum ${max} characters)`);
    return value.trim();
}
export async function checkImage(root, path) {
    if (typeof path !== 'string' || !/^media\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(path))
        throw new Error('Screenshots must be local media/name.png, .jpg, or .webp files');
    const base = await realpath(resolve(root, 'media'));
    const file = await realpath(resolve(root, path));
    if (!file.startsWith(base + sep) || !(await stat(file)).isFile())
        throw new Error('Screenshot escapes media directory or is not a file');
    const bytes = await readFile(file);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!(path.endsWith('.png') ? png : /\.jpe?g$/.test(path) ? jpg : webp))
        throw new Error('Screenshot bytes do not match the image extension');
}
// Deliberately small Markdown dialect: raw HTML, remote images, and executable URLs are never rendered.
export function markdown(source, prefix = '../') {
    const lines = source.replace(/\r/g, '').split('\n');
    const out = [];
    let paragraph = [], list = false, code = null;
    const inline = text => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/&amp;#(\d+);/g, '&#$1;');
    const flush = () => { if (paragraph.length)
        out.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; if (list)
        out.push('</ul>'); list = false; };
    for (const line of lines) {
        if (line.startsWith('```')) {
            flush();
            if (code === null)
                code = [];
            else {
                out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
                code = null;
            }
            continue;
        }
        if (code !== null) {
            code.push(line);
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        const heading = /^(#{1,3}) (.+)$/.exec(line);
        const image = /^!\[([^\]]+)\]\((media\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp))\)$/.exec(line);
        if (heading) {
            flush();
            const level = Math.max(2, heading[1].length);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        }
        else if (image) {
            flush();
            out.push(`<figure><img src="${prefix}${image[2]}" alt="${escapeHtml(image[1])}" loading="lazy"><figcaption>${escapeHtml(image[1])}</figcaption></figure>`);
        }
        else if (line.startsWith('- ')) {
            if (paragraph.length)
                flush();
            if (!list)
                out.push('<ul>');
            list = true;
            out.push(`<li>${inline(line.slice(2))}</li>`);
        }
        else {
            if (list)
                flush();
            paragraph.push(line);
        }
    }
    flush();
    if (code !== null)
        throw new Error('Unclosed Markdown code fence');
    return out.join('\n');
}
export async function readPosts(root) {
    const files = (await readdir(resolve(root, 'posts'))).filter(file => file.endsWith('.md')).sort();
    const posts = [];
    for (const file of files) {
        if (!/^[a-z0-9-]+\.md$/.test(file))
            throw new Error(`Invalid post filename: ${file}`);
        const raw = await readFile(resolve(root, 'posts', file), 'utf8');
        const match = /^---\n([^]*?)\n---\n([^]*)$/.exec(raw.replace(/\r/g, ''));
        if (!match)
            throw new Error(`Missing JSON front matter: ${file}`);
        const meta = JSON.parse(match[1]);
        textField(meta.title, 'title', 160);
        textField(meta.summary, 'summary', 500);
        if (!validDate(meta.date))
            throw new Error(`Invalid post date: ${file}`);
        const body = match[2];
        for (const image of body.matchAll(/^!\[[^\]]+\]\(([^)]+)\)$/gm))
            await checkImage(root, image[1]);
        posts.push({ ...meta, slug: file.slice(0, -3), html: markdown(body) });
    }
    return posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
