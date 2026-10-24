import { mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeHtml as e, readPosts } from './content.mjs';
export const siteRoot = fileURLToPath(new URL('.', import.meta.url));
const artwork = 'media/goliath-social-preview-1280x640.png';
const wordmark = prefix => `<span class="brand-lockup"><img src="${prefix}${artwork}" width="1280" height="640" alt="Goliath"></span>`;
function portal() {
    return `<section class="portal-intro" aria-label="Enter the Goliath field logs" hidden><div class="portal-top"><span>GOLIATH / FIELD LOGS</span><button class="skip-intro" type="button">SKIP INTRO</button></div><div class="portal-mobile-brand">${wordmark('./')}</div><div class="crystal-scene"><img class="native-art" src="./${artwork}" width="1280" height="640" alt="Goliath — the ultimate agentic browser. Orange hands surround a glowing crystal ball."><button class="orb-trigger" type="button" aria-label="PRESS START — reveal the field logs"><span>PRESS START<span class="cursor" aria-hidden="true">_</span></span><small>LOOK INSIDE THE CRYSTAL BALL</small></button></div><div class="portal-bottom"><span class="boot-message">CRYSTAL LINK <b>READY</b></span><p>Real browser runs. Lessons from the other side.</p><span>NO CREDITS REQUIRED</span></div></section>`;
}
function shell(title, body, depth = 0, current = 'start') {
    const p = depth ? '../' : './';
    const link = (id, label, href) => `<a ${current === id ? 'aria-current="page"' : ''} href="${href}"><span>${id === 'start' ? '00' : id === 'posts' ? '01' : '02'}</span> ${label}<span aria-hidden="true">↗</span></a>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="description" content="Goliath field logs. Notes from the browser frontier."><title>${e(title)} · Goliath</title><link rel="icon" href="${p}media/goliath-social-preview-1280x640.png" type="image/png"><link rel="stylesheet" href="${p}style.css"><script src="${p}app.js" defer></script></head>
<body>${current === 'start' ? portal() : ''}<a class="skip" href="#main">Skip to content</a><div class="cabinet"><header class="masthead"><a href="${p}index.html" class="brand" aria-label="Goliath home">${wordmark(p)}<span class="brand-sub">BROWSER AUTOMATION<br>FIELD LOGS</span></a><button class="effects" type="button" aria-pressed="true" hidden>CRT FX: ON</button></header>
<div class="system-line"><span>GOLIATH FIELD TERMINAL</span><span>READ. RUN. RECORD.</span></div>
<div class="layout"><aside class="sidebar"><p class="eyebrow">SELECT LEVEL</p><nav aria-label="Level select">${link('start', 'START', p + 'index.html')}${link('posts', 'POSTS', p + 'posts/index.html')}${link('manual', 'MANUAL', p + 'manual.html')}</nav><div class="side-note"><span class="small-cross" aria-hidden="true">+</span><p>A field journal for<br>the browser frontier.</p><p class="muted">No credits needed.<br>Curiosity required.</p></div><div class="side-bottom">PLAYER 01<br><span class="muted">YOU ARE HERE</span></div></aside><main id="main" tabindex="-1">${body}</main></div>
<footer><span>GOLIATH / HEADLESS, HANDS-ON.</span><a href="${p}posts/index.html">CONTINUE READING <span aria-hidden="true">→</span></a></footer></div></body></html>\n`;
}
function rows(posts, prefix = '') {
    return posts.map((post, i) => `<li><a class="post-row" href="${prefix}${post.slug}.html"><span class="post-number">${String(i + 1).padStart(2, '0')}</span><div><span class="post-date">${e(post.date)} / FIELD REPORT</span><h3>${e(post.title)}</h3><p>${e(post.summary)}</p></div><span class="row-arrow" aria-hidden="true">↗</span></a></li>`).join('') || '<li class="empty">No field reports yet. The first run starts with you.</li>';
}
export async function build(root = siteRoot) {
    const posts = await readPosts(root);
    const home = `<section class="hero"><div class="boot" aria-label="Field journal ready"><span>BOOT SEQUENCE</span><span class="boot-message">JOURNAL LOADED <b>OK</b></span></div><div class="hero-top"><span class="eyebrow">BROWSER AUTOMATION. INSERT CURIOSITY.</span><span class="edition">VOL. 01</span></div><h1>THROUGH THE GLASS.<br><span>INTO THE BROWSER.</span></h1><p class="hero-copy">The field journal of the ultimate agentic browser. Real runs, hard-won lessons, and a closer look at what happened.</p><div class="start-row"><a class="start-button" href="./posts/index.html"><span aria-hidden="true">▶</span> PRESS START</a><span class="start-caption">ENTER THE FIELD LOGS<span class="cursor" aria-hidden="true">_</span></span></div><div class="crystal-emblem" aria-hidden="true"><img src="./${artwork}" width="1280" height="640" alt=""></div><button class="replay-intro" type="button" hidden>REPLAY CRYSTAL INTRO</button><div class="hero-floor" aria-hidden="true"></div></section><section class="latest"><div class="section-head"><h2>LATEST TRANSMISSION</h2><span>${String(posts.length).padStart(2, '0')} ${posts.length === 1 ? 'ENTRY' : 'ENTRIES'}</span></div><ol class="post-list">${rows(posts.slice(0, 3), 'posts/')}</ol><a class="text-link" href="./posts/index.html">VIEW ALL POSTS <span aria-hidden="true">→</span></a></section><div class="bottom-message"><span aria-hidden="true">+</span> THE BEST RUN IS THE ONE YOU LEARN FROM. <span aria-hidden="true">+</span></div>`;
    const index = `<section class="page-heading"><p class="eyebrow">LEVEL 01 / THE ARCHIVE</p><h1>FIELD LOGS<span class="cursor" aria-hidden="true">_</span></h1><p>What happened. What held up. What to try next.</p></section><section class="archive"><div class="section-head"><h2>POSTS</h2><span>${posts.length} ${posts.length === 1 ? 'ENTRY' : 'ENTRIES'} / NEWEST FIRST</span></div><ol class="post-list">${rows(posts)}</ol></section>`;
    const manual = `<section class="page-heading"><p class="eyebrow">LEVEL 02 / PLAYER MANUAL</p><h1>LEAVE A LOG.</h1><p>Turn an authorised browser run into something useful.</p></section><article class="prose"><h2>Read the field guide</h2><p>The bundled event-platform skill covers email codes, authenticated feeds, trusted clicks, and checking what actually happened. Its public copy is included here.</p><p><a href="./event-ops-skill.md">Read the event-platform skill (Markdown)</a></p><h2>Record a run</h2><p>Keep a title, date, task, steps, screenshots, and result. Only describe things you observed. Mark missing evidence and unknown outcomes.</p><h2>Review, then publish</h2><p>Remove identities, account IDs, private URLs, codes, and credentials. Review screenshots too. From the repository root, run:</p><pre><code>node site/publish.mjs path/to/reviewed-run.json</code></pre><p>This writes a Markdown post and rebuilds the local site. It does not deploy or upload anything.</p><p><a href="./examples/event-platform-run.json">View the sanitised example record</a> · <a href="./README.md">Read publishing instructions</a></p><h2>Play your way</h2><p>Use the level-select menu or PRESS START to browse. Every link works with a keyboard. The opening journal emerges from the crystal ball in the original Goliath artwork. Skip the intro or replay it from the landing page. CRT FX switches off texture and motion; reduced-motion preferences are respected automatically.</p></article>`;
    const output = new Map([['index.html', shell('Field logs', home)], ['posts/index.html', shell('Posts', index, 1, 'posts')], ['manual.html', shell('Manual', manual, 0, 'manual')]]);
    for (const post of posts)
        output.set(`posts/${post.slug}.html`, shell(post.title, `<section class="page-heading"><a class="text-link" href="./index.html">← ALL POSTS</a><p class="eyebrow">FIELD REPORT / <time datetime="${e(post.date)}">${e(post.date)}</time></p><h1 class="post-title">${e(post.title)}</h1><p>${e(post.summary)}</p></section><article class="prose">${post.html}<p class="source-link"><a href="./${post.slug}.md">READ MARKDOWN SOURCE ↗</a></p></article>`, 1, 'posts'));
    // Copy the original artwork byte-for-byte so the static folder stays standalone.
    await mkdir(resolve(root, 'media'), { recursive: true });
    await copyFile(new URL('../assets/goliath-social-preview-1280x640.png', import.meta.url), resolve(root, artwork));
    // Validate every post before changing generated pages.
    await mkdir(resolve(root, 'posts'), { recursive: true });
    for (const [name, html] of output) {
        const path = resolve(root, name);
        await writeFile(path + '.tmp', html);
        await rename(path + '.tmp', path);
    }
    const { readFile } = await import('node:fs/promises');
    const skill = await readFile(new URL('../skills/luma-event-ops/SKILL.md', import.meta.url));
    await writeFile(resolve(root, 'event-ops-skill.md'), skill);
    await writeFile(resolve(root, '.nojekyll'), '');
    return `Built ${posts.length} post(s), index, landing page, and manual.`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        console.log(await build());
    }
    catch (error) {
        console.error(`Build failed: ${error.message}`);
        process.exitCode = 1;
    }
}
