# Goliath field logs

A static arcade journal: plain HTML/CSS/JS, local system fonts, no trackers,
remote assets, paid services, or build dependencies. Node.js 22+ is enough to
build and publish offline. Generated HTML is checked in, so the site also reads
without JavaScript. The optional CRT button stores only a local display preference.

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

## Preview

```bash
node site/serve.mjs
```

The preview server binds to `0.0.0.0`, uses `CONDUCTOR_PORT` when provided, and
otherwise asks the operating system for an available port. It prints the URL.
In Conductor use the forwarded URL for that port. Stop with Ctrl+C. The server
serves only `site/`; it never serves private run records elsewhere in the repo.

## Static hosting and GitHub Pages compatibility

The checked-in `site/` directory is the complete static document root. Relative
links work at `/` or a project subpath such as `/goliath/`. The `.nojekyll` file
keeps the output as ordinary static files. Any static server can host it without
a build service.

GitHub Pages branch sources accept a branch root or `/docs`, not `/site`. To
host this artifact there, a dedicated Pages branch would contain the contents
of `site/` at its root. However, [GitHub documents that even branch-based Pages
deployments use a managed Actions workflow run](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
That conflicts with this repository's no-Actions policy. The files are
Pages-compatible, but deploying to Pages requires a separate policy decision;
do not enable or dispatch Actions under the existing rules. No Pages settings,
CI wiring, workflow files, or deployment are changed by this feature.
