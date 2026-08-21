#!/usr/bin/env node
/**
 * Hands-driven behavioral gate benchmark.
 *
 * Proves POST /tabs/:tabId/hands ("voodoo hands") works against a LIVE browser:
 * boots the gate fixtures, drives each of the 7 families through a SINGLE
 * multi-step hands call (click/type/select/wait/scroll/press), then reads
 * window.gateState.success for a per-family pass/fail scorecard.
 *
 * Uses an externally-booted goliath (GOLIATH_BASE) rather than spawning its own.
 */
import http from 'node:http';

const BASE = process.env.GOLIATH_BASE || 'http://127.0.0.1:9378';
const USER_ID = 'vh-hands-live';
const SESSION_KEY = 'hands-gates';

// ---- Gate fixtures (self-contained copy of behavioral-gate-harness.js) ----
const gates = [
  ...[
    ['vehicle', ['apple', 'train', 'pear'], 'train'],
    ['animal', ['hammer', 'otter', 'chair'], 'otter'],
    ['tool', ['cloud', 'wrench', 'river'], 'wrench'],
    ['color', ['triangle', 'violet', 'ladder'], 'violet'],
  ].map(([prompt, choices, answer], index) => ({ id: `semantic-${index + 1}`, family: 'semantic', prompt, choices, answer })),
  { id: 'spatial-1', family: 'spatial', prompt: 'leftmost', choices: ['a', 'b', 'c'], answer: 'a' },
  { id: 'spatial-2', family: 'spatial', prompt: 'rightmost', choices: ['a', 'b', 'c'], answer: 'c' },
  { id: 'spatial-3', family: 'spatial', prompt: 'top', choices: ['a', 'b', 'c'], answer: 'b' },
  { id: 'spatial-4', family: 'spatial', prompt: 'bottom', choices: ['a', 'b', 'c'], answer: 'c' },
  ...[140, 190, 240, 290].map((delay, index) => ({ id: `timing-${index + 1}`, family: 'timing', delay })),
  ...[
    ['boat', ['boat', 'tree', 'boat', 'car', 'dog', 'boat']],
    ['star', ['star', 'moon', 'sun', 'star', 'cloud', 'star']],
    ['bird', ['cat', 'bird', 'bird', 'fish', 'house', 'bird']],
    ['key', ['lock', 'key', 'door', 'key', 'bell', 'key']],
  ].map(([target, cells], index) => ({ id: `grid-${index + 1}`, family: 'grid', target, cells })),
  ...[
    ['amber', 'indigo'], ['north', 'east'], ['circle', 'square'], ['one', 'three'],
  ].map((sequence, index) => ({ id: `multi-${index + 1}`, family: 'multi-step', sequence })),
  ...[
    ['data-orbit', 'kepler'], ['aria-label', 'curie'], ['title', 'turing'], ['data-signal', 'shannon'],
  ].map(([attribute, answer], index) => ({ id: `schema-${index + 1}`, family: 'unseen-schema', attribute, answer })),
  { id: 'input-1', family: 'input', action: 'type', answer: 'variable cadence' },
  { id: 'input-2', family: 'input', action: 'scroll', answer: 520 },
];

// Optional family filter (e.g. FAMILY=grid runs only the grid gates) for fast iteration.
const FAMILY_FILTER = process.env.FAMILY || null;
const activeGates = FAMILY_FILTER ? gates.filter(g => g.family === FAMILY_FILTER) : gates;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function gateMarkup(gate) {
  if (gate.family === 'semantic') {
    return `<p>Click the only ${escapeHtml(gate.prompt)}.</p><div class="row">${gate.choices.map(c => `<button data-choice="${c}">${c}</button>`).join('')}</div>`;
  }
  if (gate.family === 'spatial') {
    const positions = gate.prompt === 'top'
      ? [[80, 180], [250, 50], [420, 260]]
      : gate.prompt === 'bottom'
        ? [[80, 60], [250, 160], [420, 280]]
        : [[60, 160], [260, 160], [460, 160]];
    return `<p>Click the ${gate.prompt} button.</p><div class="field">${gate.choices.map((c, i) => `<button data-choice="${c}" style="left:${positions[i][0]}px;top:${positions[i][1]}px">${c}</button>`).join('')}</div>`;
  }
  if (gate.family === 'timing') {
    return `<p>Wait for the control to become ready, then click it.</p><button id="ready" disabled>not ready</button>`;
  }
  if (gate.family === 'grid') {
    return `<p>Select every ${gate.target}, then submit.</p><div class="grid">${gate.cells.map((cell, i) => `<button data-cell="${i}" data-kind="${cell}">${cell}</button>`).join('')}</div><button id="submit">submit</button>`;
  }
  if (gate.family === 'multi-step') {
    return `<p>Click ${gate.sequence[0]}, then ${gate.sequence[1]}.</p><div class="row">${[...gate.sequence].reverse().map(v => `<button data-step="${v}">${v}</button>`).join('')}</div>`;
  }
  if (gate.family === 'input' && gate.action === 'type') {
    return `<p>Type the phrase with natural cadence.</p><input id="phrase" autocomplete="off" aria-label="phrase">`;
  }
  if (gate.family === 'input') {
    return `<p>Scroll beyond the marker.</p><div style="height:1200px;padding-top:700px"><div id="marker">marker</div></div>`;
  }
  const decoy = gate.attribute === 'title' ? 'data-title' : 'data-decoy';
  return `<p>Use the unfamiliar signal to choose ${gate.answer}.</p><div class="row"><button ${decoy}="${gate.answer}">decoy</button><button ${gate.attribute}="${gate.answer}">${gate.answer}</button><button ${gate.attribute}="other">other</button></div>`;
}

function gateScript(gate) {
  const serialized = JSON.stringify(gate).replace(/</g, '\\u003c');
  return `<script>
    const gate = ${serialized};
    window.gateState = { success: false, selected: [], sequence: [], events: [] };
    for (const type of ['mousemove', 'pointerdown', 'pointerup', 'wheel', 'keydown']) {
      addEventListener(type, event => gateState.events.push({ type, at: performance.now(), x: event.clientX || 0, y: event.clientY || 0 }), { passive: true });
    }
    if (gate.family === 'semantic' || gate.family === 'spatial') {
      document.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => { gateState.success = b.dataset.choice === gate.answer; }));
    } else if (gate.family === 'timing') {
      const button = document.querySelector('#ready');
      setTimeout(() => { button.disabled = false; button.textContent = 'ready'; }, gate.delay);
      button.addEventListener('click', () => { gateState.success = !button.disabled; });
    } else if (gate.family === 'grid') {
      document.querySelectorAll('[data-cell]').forEach(b => b.addEventListener('click', () => {
        b.classList.toggle('selected');
        gateState.selected = [...document.querySelectorAll('[data-cell].selected')].map(i => Number(i.dataset.cell));
      }));
      document.querySelector('#submit').addEventListener('click', () => {
        const expected = gate.cells.map((cell, i) => cell === gate.target ? i : -1).filter(i => i >= 0);
        gateState.success = JSON.stringify(gateState.selected.sort()) === JSON.stringify(expected.sort());
      });
    } else if (gate.family === 'multi-step') {
      document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
        gateState.sequence.push(b.dataset.step);
        gateState.success = JSON.stringify(gateState.sequence) === JSON.stringify(gate.sequence);
      }));
    } else if (gate.family === 'input' && gate.action === 'type') {
      document.querySelector('#phrase').addEventListener('input', event => { gateState.success = event.target.value === gate.answer; });
    } else if (gate.family === 'input') {
      addEventListener('scroll', () => { gateState.success = scrollY >= gate.answer; }, { passive: true });
    } else {
      const selector = '[' + gate.attribute + '="' + gate.answer + '"]';
      document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { gateState.success = b.matches(selector); }));
    }
  </script>`;
}

function gatePage(gate) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:18px system-ui;margin:32px;background:#f7f4ed;color:#18202a}.row{display:flex;gap:28px;margin-top:32px}
    button{min-width:100px;min-height:52px;font:inherit;border:2px solid #334;background:white;border-radius:9px}.field{position:relative;height:350px}.field button{position:absolute}
    .grid{display:grid;grid-template-columns:repeat(3,120px);gap:16px;margin:24px 0}.grid button.selected{background:#b9e6c5}
  </style></head><body><h1>${gate.id}</h1>${gateMarkup(gate)}${gateScript(gate)}</body></html>`;
}

// ---- API helpers ----
async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${body.error || text}`);
  return body;
}

function handsStepsFor(gate) {
  const steps = [];
  if (gate.family === 'semantic' || gate.family === 'spatial') {
    steps.push({ action: 'click', selector: `[data-choice="${gate.answer}"]` });
  } else if (gate.family === 'timing') {
    steps.push({ action: 'wait', ms: gate.delay + 60 });
    steps.push({ action: 'click', selector: '#ready' });
  } else if (gate.family === 'grid') {
    gate.cells.forEach((cell, index) => {
      if (cell === gate.target) steps.push({ action: 'click', selector: `[data-cell="${index}"]` });
    });
    steps.push({ action: 'click', selector: '#submit' });
  } else if (gate.family === 'multi-step') {
    for (const s of gate.sequence) steps.push({ action: 'click', selector: `[data-step="${s}"]` });
  } else if (gate.family === 'input' && gate.action === 'type') {
    steps.push({ action: 'type', selector: '#phrase', text: gate.answer, mode: 'keyboard' });
  } else if (gate.family === 'input') {
    steps.push({ action: 'scroll', direction: 'down', amount: gate.answer + 160 });
  } else {
    steps.push({ action: 'click', selector: `[${gate.attribute}="${gate.answer}"]` });
  }
  return steps;
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`hands-live-benchmark — live smoke/benchmark for POST /tabs/:tabId/hands (voodoo hands)

Requires an externally-booted goliath server (it does NOT spawn its own). Drives
each behavioral gate through a single multi-step hands call against a real
Camoufox browser and reports a per-family pass/fail scorecard.

Usage:
  node scripts/hands-live-benchmark.js [--help]

Env:
  GOLIATH_BASE   base URL of a running goliath server (default http://127.0.0.1:9378)
  FAMILY         only run gates for one family, e.g. FAMILY=grid (default: all)

Exit code is 0 when every gate passes, 1 otherwise.
`);
    return;
  }
  const fixtureServer = http.createServer((req, res) => {
    const m = req.url?.match(/^\/gate\/([^/?]+)/);
    const gate = m && gates.find(g => g.id === decodeURIComponent(m[1]));
    if (!gate) { res.writeHead(404).end('nf'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(gatePage(gate));
  });
  const fixturePort = await listen(fixtureServer);

  const created = await api('/tabs', {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url: `http://127.0.0.1:${fixturePort}/gate/${activeGates[0].id}` }),
  });
  const tabId = created.tabId;
  console.log(`tab created: ${tabId} @ ${BASE} (${activeGates.length} gates)`);

  const results = [];
  for (const [index, gate] of activeGates.entries()) {
    if (index > 0) {
      await api(`/tabs/${tabId}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ userId: USER_ID, url: `http://127.0.0.1:${fixturePort}/gate/${gate.id}` }),
      });
    }
    const started = performance.now();
    const steps = handsStepsFor(gate);
    let response, error = null;
    try {
      response = await api(`/tabs/${tabId}/hands`, {
        method: 'POST',
        body: JSON.stringify({ userId: USER_ID, steps, humanized: { profile: 'balanced' } }),
      });
    } catch (e) { error = e.message; }
    const state = await api(`/tabs/${tabId}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, expression: '({ success: window.gateState.success, eventCount: window.gateState.events.length })' }),
    }).catch(e => ({ result: { success: false, eventCount: 0 }, error: e.message }));

    const resEntry = {
      id: gate.id, family: gate.family,
      pass: Boolean(state.result?.success),
      handsCompleted: response ? `${response.completed}/${response.total}` : 'n/a',
      handsOk: Boolean(response?.ok),
      latencyMs: Math.round(performance.now() - started),
      eventCount: state.result?.eventCount || 0,
      error: error || state.error || null,
    };
    results.push(resEntry);
    console.log(`${results.length.toString().padStart(2)}. ${gate.id.padEnd(14)} family=${gate.family.padEnd(13)} gate=${resEntry.pass ? 'PASS' : 'FAIL'}  hands=${resEntry.handsCompleted}  (${resEntry.latencyMs}ms, ${resEntry.eventCount} events)`);
  }

  let behavior = null;
  try { behavior = await api(`/tabs/${tabId}/behavior?userId=${encodeURIComponent(USER_ID)}`); }
  catch (e) { behavior = { error: e.message }; }

  const passed = results.filter(r => r.pass).length;
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)] || 0;
  const byFamily = {};
  for (const r of results) {
    byFamily[r.family] = byFamily[r.family] || { passed: 0, total: 0 };
    byFamily[r.family].total++;
    if (r.pass) byFamily[r.family].passed++;
  }
  const report = {
    LIVE_TEST_RESULT: passed === results.length ? 'PASS' : 'FAIL',
    engine: 'Live Camoufox browser via POST /tabs/:tabId/hands (voodoo hands)',
    scope: 'Synthetic behavioral gates; proves hands executes multi-step interactions on a live page. Does NOT prove third-party CAPTCHA acceptance or semantic reasoning.',
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: Number((passed / results.length).toFixed(3)),
    latencyMs: { median, max: Math.max(...latencies) },
    byFamily,
    behavior,
    failures: results.filter(r => !r.pass),
    raw: results,
  };
  process.stdout.write(`\n=== LIVE HANDS SCORECARD ===\n${JSON.stringify(report, null, 2)}\n`);

  await api(`/sessions/${USER_ID}`, { method: 'DELETE' }).catch(() => {});
  fixtureServer.close();
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(err => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
