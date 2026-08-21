#!/usr/bin/env node

import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const USER_ID = 'behavioral-gate-harness';
const SESSION_KEY = 'synthetic-gates';

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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function gateMarkup(gate) {
  if (gate.family === 'semantic') {
    return `<p>Click the only ${escapeHtml(gate.prompt)}.</p><div class="row">${gate.choices.map(choice => `<button data-choice="${choice}">${choice}</button>`).join('')}</div>`;
  }
  if (gate.family === 'spatial') {
    const positions = gate.prompt === 'top'
      ? [[80, 180], [250, 50], [420, 260]]
      : gate.prompt === 'bottom'
        ? [[80, 60], [250, 160], [420, 280]]
        : [[60, 160], [260, 160], [460, 160]];
    return `<p>Click the ${gate.prompt} button.</p><div class="field">${gate.choices.map((choice, index) => `<button data-choice="${choice}" style="left:${positions[index][0]}px;top:${positions[index][1]}px">${choice}</button>`).join('')}</div>`;
  }
  if (gate.family === 'timing') {
    return `<p>Wait for the control to become ready, then click it.</p><button id="ready" disabled>not ready</button>`;
  }
  if (gate.family === 'grid') {
    return `<p>Select every ${gate.target}, then submit.</p><div class="grid">${gate.cells.map((cell, index) => `<button data-cell="${index}" data-kind="${cell}">${cell}</button>`).join('')}</div><button id="submit">submit</button>`;
  }
  if (gate.family === 'multi-step') {
    return `<p>Click ${gate.sequence[0]}, then ${gate.sequence[1]}.</p><div class="row">${[...gate.sequence].reverse().map(value => `<button data-step="${value}">${value}</button>`).join('')}</div>`;
  }
  if (gate.family === 'input' && gate.action === 'type') {
    return `<p>Type the phrase with natural cadence.</p><input id="phrase" autocomplete="off" aria-label="phrase">`;
  }
  if (gate.family === 'input') {
    return `<p>Scroll beyond the marker.</p><div style="height:1200px;padding-top:700px"><div id="marker">marker</div></div>`;
  }
  const decoyAttribute = gate.attribute === 'title' ? 'data-title' : 'data-decoy';
  return `<p>Use the unfamiliar signal to choose ${gate.answer}.</p><div class="row"><button ${decoyAttribute}="${gate.answer}">decoy</button><button ${gate.attribute}="${gate.answer}">${gate.answer}</button><button ${gate.attribute}="other">other</button></div>`;
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
      document.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => { gateState.success = button.dataset.choice === gate.answer; }));
    } else if (gate.family === 'timing') {
      const button = document.querySelector('#ready');
      setTimeout(() => { button.disabled = false; button.textContent = 'ready'; }, gate.delay);
      button.addEventListener('click', () => { gateState.success = !button.disabled; });
    } else if (gate.family === 'grid') {
      document.querySelectorAll('[data-cell]').forEach(button => button.addEventListener('click', () => {
        button.classList.toggle('selected');
        gateState.selected = [...document.querySelectorAll('[data-cell].selected')].map(item => Number(item.dataset.cell));
      }));
      document.querySelector('#submit').addEventListener('click', () => {
        const expected = gate.cells.map((cell, index) => cell === gate.target ? index : -1).filter(index => index >= 0);
        gateState.success = JSON.stringify(gateState.selected.sort()) === JSON.stringify(expected.sort());
      });
    } else if (gate.family === 'multi-step') {
      document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
        gateState.sequence.push(button.dataset.step);
        gateState.success = JSON.stringify(gateState.sequence) === JSON.stringify(gate.sequence);
      }));
    } else if (gate.family === 'input' && gate.action === 'type') {
      document.querySelector('#phrase').addEventListener('input', event => { gateState.success = event.target.value === gate.answer; });
    } else if (gate.family === 'input') {
      addEventListener('scroll', () => { gateState.success = scrollY >= gate.answer; }, { passive: true });
    } else {
      const selector = '[' + gate.attribute + '="' + gate.answer + '"]';
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { gateState.success = button.matches(selector); }));
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

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${path}: ${body.error || text}`);
  return body;
}

async function waitForHealth(baseUrl, child, logTail) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`goliath exited early (${child.exitCode}): ${logTail.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`goliath did not become healthy: ${logTail.join('')}`);
}

async function click(baseUrl, tabId, selector) {
  return api(baseUrl, `/tabs/${tabId}/click`, {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, selector, humanized: { profile: 'fast' } }),
  });
}

async function type(baseUrl, tabId, selector, text) {
  return api(baseUrl, `/tabs/${tabId}/type`, {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, selector, text, humanized: { profile: 'fast' } }),
  });
}

async function scroll(baseUrl, tabId, amount) {
  return api(baseUrl, `/tabs/${tabId}/scroll`, {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, direction: 'down', amount, humanized: { profile: 'fast' } }),
  });
}

async function solveGate(baseUrl, tabId, gate) {
  if (gate.family === 'semantic' || gate.family === 'spatial') {
    await click(baseUrl, tabId, `[data-choice="${gate.answer}"]`);
  } else if (gate.family === 'timing') {
    await new Promise(resolve => setTimeout(resolve, gate.delay + 40));
    await click(baseUrl, tabId, '#ready');
  } else if (gate.family === 'grid') {
    for (const [index, cell] of gate.cells.entries()) {
      if (cell === gate.target) await click(baseUrl, tabId, `[data-cell="${index}"]`);
    }
    await click(baseUrl, tabId, '#submit');
  } else if (gate.family === 'multi-step') {
    for (const step of gate.sequence) await click(baseUrl, tabId, `[data-step="${step}"]`);
  } else if (gate.family === 'input' && gate.action === 'type') {
    await type(baseUrl, tabId, '#phrase', gate.answer);
  } else if (gate.family === 'input') {
    await scroll(baseUrl, tabId, gate.answer + 180);
  } else {
    await click(baseUrl, tabId, `[${gate.attribute}="${gate.answer}"]`);
  }
}

const FINGERPRINT_EXPRESSION = `(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d34'; ctx.fillRect(1, 2, 20, 9); ctx.fillText('goliath', 2, 14);
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
  let audioSample = null;
  try {
    const audio = new OfflineAudioContext(1, 2048, 44100);
    const oscillator = audio.createOscillator(); const compressor = audio.createDynamicsCompressor();
    oscillator.type = 'triangle'; oscillator.frequency.value = 10000; oscillator.connect(compressor); compressor.connect(audio.destination); oscillator.start(0);
    const rendered = await audio.startRendering();
    audioSample = Array.from(rendered.getChannelData(0).slice(1000, 1032)).reduce((sum, value, index) => sum + Math.abs(value) * (index + 1), 0).toFixed(8);
  } catch (_) {}
  return {
    webdriver: navigator.webdriver, plugins: navigator.plugins.length, userAgent: navigator.userAgent,
    platform: navigator.platform, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    windowChromePresent: 'chrome' in window, canvasSample: canvas.toDataURL().slice(-48), webgl: Boolean(gl),
    webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, audioSample,
  };
})()`;

async function fingerprintSample(baseUrl, tabId, userId) {
  return (await api(baseUrl, `/tabs/${tabId}/evaluate`, {
    method: 'POST', body: JSON.stringify({ userId, expression: FINGERPRINT_EXPRESSION }),
  })).result;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function main() {
  const fixtureServer = http.createServer((request, response) => {
    const match = request.url?.match(/^\/gate\/([^/?]+)/);
    const gate = match && gates.find(item => item.id === decodeURIComponent(match[1]));
    if (!gate) { response.writeHead(404).end('not found'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(gatePage(gate));
  });
  const fixturePort = await listen(fixtureServer);
  const goliathPort = await freePort();
  const baseUrl = `http://127.0.0.1:${goliathPort}`;
  const logTail = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GOLIATH_PORT: String(goliathPort), BROWSER_IDLE_TIMEOUT_MS: '600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      logTail.push(chunk.toString());
      if (logTail.length > 30) logTail.shift();
    });
  }

  try {
    await waitForHealth(baseUrl, child, logTail);
    const created = await api(baseUrl, '/tabs', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url: `http://127.0.0.1:${fixturePort}/gate/${gates[0].id}` }),
    });
    const results = [];
    for (const [index, gate] of gates.entries()) {
      if (index > 0) {
        await api(baseUrl, `/tabs/${created.tabId}/navigate`, {
          method: 'POST',
          body: JSON.stringify({ userId: USER_ID, url: `http://127.0.0.1:${fixturePort}/gate/${gate.id}` }),
        });
      }
      const started = performance.now();
      let error = null;
      try { await solveGate(baseUrl, created.tabId, gate); } catch (caught) { error = caught.message; }
      const state = await api(baseUrl, `/tabs/${created.tabId}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({ userId: USER_ID, expression: '({ success: window.gateState.success, eventCount: window.gateState.events.length })' }),
      }).catch(caught => ({ result: { success: false, eventCount: 0 }, error: caught.message }));
      results.push({ id: gate.id, family: gate.family, pass: Boolean(state.result?.success), latencyMs: Math.round(performance.now() - started), eventCount: state.result?.eventCount || 0, error: error || state.error || null });
    }

    const fingerprintA = await fingerprintSample(baseUrl, created.tabId, USER_ID);
    const fingerprintARepeat = await fingerprintSample(baseUrl, created.tabId, USER_ID);
    const secondUser = `${USER_ID}-second`;
    const secondTab = await api(baseUrl, '/tabs', {
      method: 'POST', body: JSON.stringify({ userId: secondUser, sessionKey: SESSION_KEY, url: `http://127.0.0.1:${fixturePort}/gate/${gates[0].id}` }),
    });
    const fingerprintB = await fingerprintSample(baseUrl, secondTab.tabId, secondUser);
    await api(baseUrl, `/sessions/${secondUser}`, { method: 'DELETE' });
    const stableFields = ['canvasSample', 'audioSample', 'webglVendor', 'webglRenderer'];
    const coherentFields = ['userAgent', 'platform', 'language', 'timezone', 'windowChromePresent'];
    const fingerprint = {
      sample: fingerprintA,
      withinSessionStable: Object.fromEntries(stableFields.map(field => [field, fingerprintA[field] === fingerprintARepeat[field]])),
      crossSessionCoherent: Object.fromEntries(coherentFields.map(field => [field, fingerprintA[field] === fingerprintB[field]])),
      crossSessionSurfaceEquality: Object.fromEntries(stableFields.map(field => [field, fingerprintA[field] === fingerprintB[field]])),
      externalSurfaces: { tlsJa3: 'not-tested-local', ipReputation: 'not-tested-local' },
    };
    const behavior = await api(baseUrl, `/tabs/${created.tabId}/behavior?userId=${encodeURIComponent(USER_ID)}`);
    const passed = results.filter(result => result.pass).length;
    const latencies = results.map(result => result.latencyMs);
    const report = {
      scope: 'Local synthetic interaction benchmark; deterministic solvers are used, so this does not prove autonomous semantic reasoning or third-party CAPTCHA acceptance.',
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: Number((passed / results.length).toFixed(3)),
      latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
      byFamily: Object.fromEntries(Array.from(new Set(results.map(result => result.family))).map(family => {
        const familyResults = results.filter(result => result.family === family);
        return [family, { passed: familyResults.filter(result => result.pass).length, total: familyResults.length }];
      })),
      fingerprint,
      behavior,
      failures: results.filter(result => !result.pass),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await api(baseUrl, `/sessions/${USER_ID}`, { method: 'DELETE' }).catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    await new Promise(resolve => fixtureServer.close(resolve));
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
