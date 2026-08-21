# Persistence Plugin — Agent Guide

Saves and restores per-user browser storage state (cookies + localStorage) across session restarts using Playwright's `storageState` API. Enabled by default — profiles persist to `~/.goliath/profiles/`.

## How It Works

- `session:creating` hook → loads saved `storage_state.json` into `contextOptions.storageState`
- `session:created` hook → imports bootstrap cookies if no persisted state exists
- `session:cookies:import` / `session:destroyed` / `server:shutdown` → checkpoints state to disk

All hooks are async and awaited via `emitAsync()` — storage state is guaranteed loaded before the context is created.

## Key Files

- `index.js` — lifecycle hooks (no routes, no `child_process`)
- `persistence.test.js` — unit tests for `lib/persistence.js` helpers
- `plugin.test.js` — integration tests for plugin lifecycle hooks

## Storage Layout

```
~/.goliath/profiles/
└── <sha256(userId)>/
    └── storage_state.json
```

## Configuration

Enabled by default. Override profile directory with `GOLIATH_PROFILE_DIR` env var or `"profileDir"` in plugin config. To disable: `"persistence": { "enabled": false }` in `goliath.config.json`.

## Original Contributors

- [@company8](https://github.com/company8) — original persistence concept
- [@eddieoz](https://github.com/eddieoz) — cookie auto-load on startup
- [@pradeepe](https://github.com/pradeepe) — plugin system integration, atomic writes, inflight coalescing

For PRs touching this plugin, tag the contributors above for review.
