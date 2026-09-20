import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../publish.mjs';
import { build } from '../build.mjs';
import { markdown } from '../content.mjs';
const record = { reviewed: true, title: 'A safe run', date: '2026-09-20', task: 'Read authorised state.', steps: ['Open a tab.', 'Read explicit state.'], screenshots: [], result: 'Observed; no change requested.' };
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'goliath-site-'));
    await mkdir(join(root, 'posts'));
    await mkdir(join(root, 'media'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
test('publishes Markdown, index, and readable entry; refuses duplicate without altering it', async (t) => {
    const root = await fixture(t);
    await publish(record, root);
    const path = join(root, 'posts/2026-09-20-a-safe-run.md');
    const before = await readFile(path, 'utf8');
    assert.match(before, /## Steps taken/);
    assert.match(await readFile(join(root, 'posts/index.html'), 'utf8'), /2026-09-20-a-safe-run.html/);
    assert.match(await readFile(join(root, 'posts/2026-09-20-a-safe-run.html'), 'utf8'), /No screenshots are included/);
    await assert.rejects(publish(record, root), /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), before);
});
test('rejects unreviewed, invalid dates, empty steps, and paths outside media', async (t) => {
    const root = await fixture(t);
    for (const bad of [{ reviewed: false }, { date: '2026-02-30' }, { steps: [] }, { title: '!!!' }, { screenshots: [{ path: '../secret.png', alt: 'state' }] }, { screenshots: [{ path: 'https://example.invalid/image.png', alt: 'state' }] }]) {
        await assert.rejects(publish({ ...record, ...bad }, root));
    }
});
test('escapes hostile HTML and Markdown in run-record fields', async (t) => {
    const root = await fixture(t);
    await publish({ ...record, result: '<script>alert(1)</script>\n![leak](https://example.invalid/private)' }, root);
    const html = await readFile(join(root, 'posts/2026-09-20-a-safe-run.html'), 'utf8');
    assert.doesNotMatch(html, /<script>alert|<img[^>]+example.invalid/);
});
test('validates image signatures and rejects escaping symlinks', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'media/fake.png'), '<script>not an image</script>');
    await assert.rejects(publish({ ...record, screenshots: [{ path: 'media/fake.png', alt: 'state' }] }, root), /bytes/);
    await writeFile(join(root, 'outside.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await symlink(join(root, 'outside.png'), join(root, 'media/escape.png'));
    await assert.rejects(publish({ ...record, screenshots: [{ path: 'media/escape.png', alt: 'state' }] }, root), /escapes/);
    await writeFile(join(root, 'media/state.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await publish({ ...record, screenshots: [{ path: 'media/state.png', alt: 'Reviewed state' }] }, root);
    assert.match(await readFile(join(root, 'posts/2026-09-20-a-safe-run.html'), 'utf8'), /src="..\/media\/state.png" alt="Reviewed state"/);
});
test('empty archive renders honestly; malformed Markdown leaves previous HTML intact', async (t) => {
    const root = await fixture(t);
    await build(root);
    const path = join(root, 'posts/index.html'), before = await readFile(path, 'utf8');
    assert.match(before, /No field reports yet/);
    await writeFile(join(root, 'posts/bad.md'), 'missing front matter');
    await assert.rejects(build(root), /front matter/);
    assert.equal(await readFile(path, 'utf8'), before);
});
test('Markdown escapes raw HTML, supports code, and fails on unclosed fences', () => {
    assert.equal(markdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    assert.match(markdown('```js\nconst x = "<";\n```'), /<pre><code>const x = &quot;&lt;&quot;;<\/code><\/pre>/);
    assert.throws(() => markdown('```\nunfinished'), /Unclosed/);
});
