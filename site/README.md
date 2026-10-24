# Goliath field logs

A static arcade journal: plain HTML/CSS/JS, local system fonts, no trackers,
remote assets, paid services, or build dependencies. Node.js 22+ is enough to
build and publish offline. Generated HTML is checked in, so the site also reads
without JavaScript. The optional CRT button stores only a local display preference.

## Native artwork and crystal reveal

The landing screen uses the repository's restored
`assets/goliath-social-preview-1280x640.png`: the green Goliath wordmark, hands,
and crystal ball. The builder copies this image byte-for-byte into `site/media/`
so hosting never needs access outside the site folder. Header and crystal crops
are CSS-only; the original artwork is not altered or redrawn.

Press the crystal ball to reveal the journal from its center. Skip Intro and
Escape reveal it immediately; Replay Crystal Intro opens it again. The intro
appears once per browser tab when storage is available. Reduced motion and CRT
FX off disable the zoom. Without JavaScript, all journal content and navigation
remain visible with no intro gate.

## Add a post from a run

1. Copy `site/examples/event-platform-run.json` to a private working location.
2. Replace the title, date (`YYYY-MM-DD`), task, steps (array of plain strings),
   screenshots (array), and result with your actual observations. State missing
   evidence explicitly. Do not present an example as a live verified run.
3. Remove private emails, names, account IDs, URLs, credentials, codes, client
   details, and internal implementation details from every field. Review images
   visually and strip identifying metadata before copying them to `site/media/`.
   The publisher validates structure and paths; it does **not** anonymise text or
   images. Set `reviewed: true` only after that review.
4. Run this from the repository root:

   ```bash
   node site/publish.mjs path/to/reviewed-run.json
   ```

The command creates `site/posts/DATE-title-slug.md` and rebuilds the landing
page, posts index, entry pages, and manual. It refuses to overwrite a post. It
does not commit, upload, deploy, or perform browser actions. Commit the reviewed
Markdown, images, and generated HTML together. An empty `screenshots` array is
valid and produces an explicit missing-evidence note.

A screenshot entry looks like this (the file must already exist):

```json
{"path":"media/reviewed-state.png","alt":"The authorised state after the action, with identifying details removed"}
```

Only local PNG, JPEG, and WebP files directly inside `site/media/` are accepted.
External URLs, traversal, escaping symlinks, SVGs, and mismatched image signatures
are rejected. Text values are rendered as text, not executable HTML.

The included record is a sanitised retrospective of an operator-reported run.
Its date is the publication date. Original screenshots were not supplied, and
no new authenticated run or attendance outcome is claimed.

## Write or edit Markdown directly

Use a lowercase, hyphenated `.md` filename under `site/posts/` with JSON front
matter between `---` lines:

```markdown
---
{"title":"A reviewed run","date":"2026-09-20","summary":"What this run taught us."}
---

## Task

Describe the authorised task.

## Result

Describe the observed result and its limits.
```

Supported Markdown: paragraphs, headings (`#` through `###`), `-` lists,
`**bold**`, inline backticks, fenced code blocks, and standalone local screenshot
images. Raw HTML is escaped. General Markdown links, tables, and nested lists
are intentionally unsupported; unsupported syntax stays visible as text.
Then rebuild:

```bash
node site/build.mjs
node --test site/tests/*.test.mjs
```

When deleting or renaming a post, also remove its old generated `.html` file;
the builder does not delete files automatically.

## Publish from the owner box

The checked-in `site/` folder is plain HTML/CSS/JS and is ready to serve as-is.
No build step, framework, hosting account, or package installation is needed to
serve it. The existing offline Markdown builder is only for changing posts.
Any static server can serve this folder; the provided launcher uses Node.js 22+
and an installed `cloudflared` binary.

From the owner box, run:

```bash
./site/serve.sh
```

You can also invoke the script by absolute path from any directory. It resolves
the site folder relative to itself, starts its own static server bound **only to
127.0.0.1:8801**, then runs exactly:

```bash
cloudflared tunnel --url http://127.0.0.1:8801 --no-autoupdate --logfile -
```

It scrapes the public `https://…trycloudflare.com` URL from the tunnel log and
prints it as `Public site: …`. The URL is **ephemeral: it changes each run**.
Keep the process running while sharing it. Ctrl+C stops both the tunnel and the
site server. A permanent domain requires a **named Cloudflare tunnel**, configured
separately with this same site-only origin. See [Cloudflare's quick-tunnel
documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

The tunnel must expose **only the `site/` folder**. Never point it at a gateway,
dashboard, repository root, or any other service. The launcher has no configurable
origin or document root. It refuses an occupied port rather than tunnelling an
existing listener; the server rejects paths and symlinks escaping `site/`, hidden
files, and directory listings. Keep only reviewed public material in `site/`.

To prevent inherited routes, the launcher rejects existing cloudflared
`config.yml`/`config.yaml` files in the usual user/system configuration directories
and does not pass inherited `TUNNEL_*` options. It does not edit or delete those
files: use an unconfigured account if necessary. Tunnel logs and any file named
`-` produced by the requested logfile option stay in a private temporary directory
outside the site and are removed on shutdown. If no URL arrives within 60 seconds,
or either process fails, the launcher stops; it does not retry in the background.

For a local preview without any tunnel:

```bash
node site/serve.mjs
# Open http://127.0.0.1:8801
```

No Vercel, hosted site platform, Pages deployment, or CI workflow is configured.
