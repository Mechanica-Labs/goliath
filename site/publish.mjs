import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, siteRoot } from './build.mjs';
import { textField, validDate, slugify, checkImage, readPosts } from './content.mjs';
// Run-record fields are plain text. Escape Markdown metacharacters so records
// cannot introduce images, links, HTML, or new front matter into a public post.
const plain = value => value.replace(/[&<>`*\[\]#_!\\]/g, c => `&#${c.charCodeAt(0)};`).replace(/\r?\n/g, ' ');
export async function publish(record, root = siteRoot) {
    if (!record || typeof record !== 'object' || record.reviewed !== true)
        throw new Error('Set reviewed: true only after reviewing all text and images for public sharing');
    const title = textField(record.title, 'title', 160), task = textField(record.task, 'task', 500), result = textField(record.result, 'result');
    if (!validDate(record.date))
        throw new Error('date must be a real YYYY-MM-DD date');
    if (!Array.isArray(record.steps) || !record.steps.length || record.steps.length > 100)
        throw new Error('steps must contain 1–100 text entries');
    const steps = record.steps.map(step => textField(step, 'step'));
    if (!Array.isArray(record.screenshots) || record.screenshots.length > 20)
        throw new Error('screenshots must be an array with at most 20 entries');
    for (const shot of record.screenshots) {
        textField(shot.alt, 'screenshot alt', 300);
        await checkImage(root, shot.path);
    }
    const slug = slugify(title);
    if (!slug)
        throw new Error('title must contain a letter or digit usable in a filename');
    await readPosts(root); // Fail before writing if existing content is malformed.
    const meta = { title, date: record.date, summary: task };
    const body = `---\n${JSON.stringify(meta, null, 2)}\n---\n\n## Task\n\n${plain(task)}\n\n## Steps taken\n\n${steps.map(step => '- ' + plain(step)).join('\n')}\n\n## Result\n\n${plain(result)}\n\n## Screenshots\n\n${record.screenshots.length ? record.screenshots.map(shot => `![${plain(shot.alt)}](${shot.path})`).join('\n\n') : 'No screenshots are included in this public record.'}\n`;
    const path = resolve(root, 'posts', `${record.date}-${slug}.md`);
    await writeFile(path, body, { flag: 'wx' }); // Never overwrite a previous report.
    try {
        await build(root);
    }
    catch (error) {
        await unlink(path);
        throw error;
    }
    return `Published posts/${record.date}-${slug}.md; rebuilt static site. Nothing uploaded.`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 3)
            throw new Error('Usage: node site/publish.mjs path/to/reviewed-run.json');
        const input = await readFile(resolve(process.argv[2]), 'utf8');
        if (Buffer.byteLength(input) > 1000000)
            throw new Error('Run record exceeds 1 MB');
        console.log(await publish(JSON.parse(input)));
    }
    catch (error) {
        console.error(`Publish failed: ${error.message}`);
        process.exitCode = 1;
    }
}
