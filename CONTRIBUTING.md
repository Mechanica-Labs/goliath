# Contributing to Goliath

Thanks for helping build Goliath. The repo is public and open to anyone — **no invitation or special access is required**. You fork, you branch, you open a pull request.

## How to contribute (the whole flow)

1. **Fork** [`Mechanica-Labs/goliath`](https://github.com/Mechanica-Labs/goliath) on GitHub.
2. **Clone your fork**, not the upstream:

   ```bash
   git clone https://github.com/<your-username>/goliath.git
   cd goliath
   ```

3. **Branch** off `main`:

   ```bash
   git checkout main
   git pull
   git checkout -b my-change
   ```

4. **Make your change.** Keep it focused — one change per PR is easier to review than a grab-bag.
5. **Push to your fork** and open a pull request against `main` from the GitHub UI.

That's it. CI runs automatically, and a maintainer reviews and merges if everything passes.

## Development setup

Fast path (tests only, no browser download):

```bash
npm ci --ignore-scripts
npm test
```

Full environment (deps + browser runtime + background server):

```bash
npm run setup      # idempotent: deps + browser runtime, fills only what's missing
npm run doctor     # verify install status, change nothing
npm run up         # background server, waits for /health
npm start          # foreground — use in Docker or under a supervisor
```

Other lifecycle commands: `npm run status`, `npm run logs`, `npm run down`, `npm run restart`. To fetch only the browser runtime, `npm run install:browser`.

## Pull request checklist

Before you open a PR, confirm:

- [ ] `npm test` passes locally
- [ ] If you changed any route in `server.js`, you ran `npm run generate-openapi` and committed the updated `openapi.json`
- [ ] No secrets, `.env` files, `node_modules/`, browser binaries, or `.tgz` tarballs are committed
- [ ] Your PR description says what changed and how you tested it

## Rules of the road

- **PRs target `main` only.** Never push directly to `main`, never force-push, never delete branches that are under review.
- **`main` is protected.** Every PR must pass the required status checks (`test`, `package-check`) and get an approving review before it can be merged.
- **Keep upstream attribution intact.** If your change touches code derived from an upstream project, leave `LICENSE` and `NOTICE.md` alone — attribution lives there, not in source comments.
- **Be a good citizen.** Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and don't commit secrets or anything you wouldn't want public.

## Questions?

Open an issue and ask. We'd rather answer a quick question than merge a guess.
