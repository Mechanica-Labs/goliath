# Goliath benchmarks

This directory contains reproducible end-to-end benchmarks for Goliath's public browser API.

The goal is not to manufacture a single "speed score." Browser-agent systems fail in multiple ways: an action can be fast but wrong, a snapshot can be complete but unusable, or a session can work once and lose state on the next tab. The benchmark therefore records correctness, latency, and API-call cost per task.

## Design principles

1. Public API only. Benchmarks call the same REST surface available to agent harnesses. They do not import Goliath internals.
2. Deterministic fixtures. Core cases run against a local HTTP fixture server, not third-party sites. Results are not coupled to network quality, site redesigns, bot defenses, accounts, or credentials.
3. Correctness before latency. A fast failed task is still a failure. Every measured case verifies a page-side effect or public API invariant.
4. Isolated samples. Every sample gets a fresh `userId` and session, then deletes it during cleanup.
5. Machine-readable output. Reports use a versioned JSON schema so results can be compared, graphed, or consumed by CI later.
6. No browser download in normal CI. The benchmark requires a live Goliath process and is intentionally opt-in. Unit and package CI remain fast.

## Run it

Start Goliath with a working browser runtime:

```sh
npm run setup
npm start
```

In another shell:

```sh
npm run benchmark
```

By default the runner executes one warmup and three measured samples for every core case.

Useful options:

```sh
npm run benchmark -- --list
npm run benchmark -- --filter snapshot
npm run benchmark -- --runs 5 --warmup 1
npm run benchmark -- --output .goliath/benchmarks/core.json
npm run benchmark -- --json
```

Use another running server with either `GOLIATH_BASE` or `--base`:

```sh
GOLIATH_BASE=http://127.0.0.1:9377 npm run benchmark
npm run benchmark -- --base http://127.0.0.1:9377
```

If the target requires authentication, the runner reads a bearer token from `GOLIATH_BENCHMARK_TOKEN`, then falls back to `GOLIATH_ACCESS_KEY` or `GOLIATH_API_KEY`. Tokens are never written to reports.

The process exits `0` only when every measured case passes every run and all warmup executions complete successfully.

## Core suite

| Case | What it proves |
| --- | --- |
| `tab-create` | A real browser tab can be created through the public API. |
| `snapshot-ref` | Accessibility snapshots expose stable page content and an actionable element ref. |
| `ref-click` | A ref discovered from the snapshot can drive a verified page-side effect. |
| `hands-form` | `hands` can complete and submit a multi-step form correctly. |
| `navigation` | Navigation produces a fresh observable document. |
| `multi-tab` | Multiple tabs remain discoverable under one browser identity/session. |
| `session-state` | Origin storage survives closing and reopening a tab in the same browser identity. |
| `dynamic-control` | A bounded wait plus action handles a control inserted asynchronously by the page. |

The suite intentionally does not claim to measure CAPTCHA acceptance, anti-bot evasion, semantic reasoning, or third-party website compatibility. Those require separate datasets and should not be conflated with deterministic browser execution.

## Report format

A report is versioned with `schemaVersion` and contains both aggregate and per-case data:

```json
{
  "schemaVersion": 1,
  "benchmark": "core",
  "suiteVersion": 1,
  "summary": {
    "pass": true,
    "successRate": 1,
    "latencyMs": { "min": 210, "p50": 278, "p95": 511, "max": 511, "mean": 301.75 }
  },
  "cases": []
}
```

Each sample records:

- pass/fail
- end-to-end latency
- number of Goliath API calls used by the case, excluding cleanup
- concise failure metadata when an assertion or HTTP request fails

Warmup executions are excluded from latency and success-rate statistics. A failed warmup is still surfaced and fails the case because intermittent startup or state failures are correctness failures, not noise.

## Adding a case

A case is a small object with an id, description, and `run` function:

```js
{
  id: 'example',
  title: 'Example task',
  description: 'What the case proves.',
  async run({ client, fixtureUrl }) {
    const { tabId } = await client.createTab(fixtureUrl('/snapshot'));
    const result = await client.evaluate(tabId, 'document.title');
    assert.equal(result.result, 'Goliath Benchmark Fixture');
  },
}
```

Prefer assertions against observable effects over implementation details. If a new case needs a page, add a minimal deterministic fixture in `benchmarks/lib/fixture-server.js`. Avoid external hosts unless the suite is explicitly intended to measure live-site compatibility.
