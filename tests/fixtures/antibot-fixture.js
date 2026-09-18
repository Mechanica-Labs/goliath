/**
 * Local repro fixture for anti-bot walls.
 *
 * Serves, from 127.0.0.1 only, the three page shapes field reports describe:
 * a visible PerimeterX-style challenge, a silent block (page renders, the form
 * does nothing and no request leaves), and a clean page. Nothing here calls the
 * real vendor hosts; the markup only carries the markers Goliath detects.
 */

import http from 'node:http';

const PX_APP_ID = 'PXfixture';
const CHALLENGE_FRAME = 'https://geo.captcha-delivery.com/captcha/?initialCid=fixture&cid=fixture';
const PX_SCRIPT = 'https://client.perimeterx.net/PXfixture/main.min.js';

function page(body, { status = 200, headers = {} } = {}) {
  const script = body.script ? `<script>${body.script}</script>` : '';
  return { status, headers, body: `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>${body.head || ''}</head><body>${body.main || ''}${script}</body></html>` };
}

const CHALLENGE = page({
  head: `<script src="${PX_SCRIPT}"></script><script>window._pxAppId='${PX_APP_ID}';window._pxChallenge={};</script>`,
  main: `
    <h1>Before you continue</h1>
    <p>Verify you are human to continue.</p>
    <iframe title="challenge" src="${CHALLENGE_FRAME}" width="400" height="200"></iframe>
    <div class="px-captcha-container"><input type="checkbox" id="px-captcha" aria-label="Verify"></div>`,
});

const SILENT = page({
  head: `<script src="${PX_SCRIPT}"></script><script>window._pxAppId='${PX_APP_ID}';window._pxhd='fixturehd';</script>`,
  main: `
    <h1>Entrar</h1>
    <p>Something went wrong. Please try again.</p>
    <form id="login" method="post" action="#"><input type="email" name="username"><input type="password" name="password"><button type="submit">Entrar</button></form>`,
}, { status: 403, headers: { 'x-px': '1', 'content-type': 'text/html' } });

const CLEAN = page({
  main: `
    <h1>Fixture inbox</h1>
    <form id="search" method="get" action="/search"><input type="search" name="q" aria-label="Search"><button type="submit">Search</button></form>
    <button id="ping" aria-label="Ping the network">Ping</button>
    <output id="pong">idle</output>
    <p>Stable marker: goliath-antibot-clean</p>`,
  // A real action on a clean page must leave the browser and come back; the
  // live verification reads this output to prove it did.
  script: `
    document.querySelector('#ping').addEventListener('click', async () => {
      const response = await fetch('/echo', { method: 'POST', body: 'ping' });
      document.querySelector('#pong').textContent = await response.text();
    });`,
});

export async function startAntibotFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const route = url.pathname;
    if (route === '/px-challenge') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(CHALLENGE.body);
    }
    if (route === '/px-silent') {
      // The 403 and the x-px header are what a real wall sends before the page
      // still renders: the agent sees a form, and nothing it does leaves.
      response.writeHead(SILENT.status, SILENT.headers);
      return response.end(SILENT.body);
    }
    if (route === '/echo') {
      response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      return response.end('pong');
    }
    if (route === '/clean' || route === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(CLEAN.body);
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    return response.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    challengeFrame: CHALLENGE_FRAME,
    appId: PX_APP_ID,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
