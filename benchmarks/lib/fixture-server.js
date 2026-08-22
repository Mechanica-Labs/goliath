import http from 'node:http';
import { once } from 'node:events';

const PAGES = {
  '/snapshot': page(`
    <h1>Snapshot Fixture</h1>
    <p>Stable marker: goliath-benchmark-snapshot</p>
    <button id="increment" aria-label="Increment counter">Increment counter</button>
    <output id="count">0</output>
    <script>
      window.__count = 0;
      document.querySelector('#increment').addEventListener('click', () => {
        window.__count += 1;
        document.querySelector('#count').textContent = String(window.__count);
      });
    </script>
  `),

  '/form': page(`
    <h1>Form Fixture</h1>
    <form id="profile-form">
      <label>First name <input id="first-name" name="firstName" autocomplete="off"></label>
      <label>Last name <input id="last-name" name="lastName" autocomplete="off"></label>
      <label>Country
        <select id="country" name="country">
          <option value="">Select</option>
          <option value="BG">Bulgaria</option>
          <option value="LI">Liechtenstein</option>
          <option value="AE">United Arab Emirates</option>
        </select>
      </label>
      <button id="submit" type="submit">Save profile</button>
    </form>
    <output id="result"></output>
    <script>
      window.__formResult = null;
      document.querySelector('#profile-form').addEventListener('submit', event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        window.__formResult = Object.fromEntries(data.entries());
        document.querySelector('#result').textContent = JSON.stringify(window.__formResult);
      });
    </script>
  `),

  '/navigation': page(`
    <h1>Navigation Fixture</h1>
    <a href="/destination">Go to destination</a>
  `),

  '/destination': page(`
    <h1>Destination Fixture</h1>
    <p>Stable marker: goliath-benchmark-destination</p>
  `),

  '/state': page(`
    <h1>State Fixture</h1>
    <p>Stable marker: goliath-benchmark-state</p>
  `),

  '/dynamic': page(`
    <h1>Dynamic Fixture</h1>
    <p>Control appears asynchronously.</p>
    <div id="mount"></div>
    <script>
      window.__dynamicClicked = false;
      setTimeout(() => {
        const button = document.createElement('button');
        button.id = 'delayed-action';
        button.textContent = 'Delayed action';
        button.addEventListener('click', () => { window.__dynamicClicked = true; });
        document.querySelector('#mount').appendChild(button);
      }, 120);
    </script>
  `),
};

function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Goliath Benchmark Fixture</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; }
    form { display: grid; gap: 16px; max-width: 420px; }
    label { display: grid; gap: 6px; }
    input, select, button { font: inherit; padding: 8px 10px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body = PAGES[url.pathname];

    if (!body) {
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('fixture not found');
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('fixture server did not expose a TCP address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
