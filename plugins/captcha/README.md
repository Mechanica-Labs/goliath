# Goliath Captcha Plugin

Automate solving CAPTCHA walls inside Goliath's browser so agents can advance
past anti-bot checks — Doordash, ticket sites, login gates, Cloudflare.

## Enable

```json
// goliath.config.json
{
  "plugins": {
    "captcha": { "enabled": true, "provider": "capsolver", "apiKey": "YOUR_KEY" }
  }
}
```

Or via environment variables (no config edit needed):

```bash
export GOLIATH_CAPTCHA_ENABLED=1
export GOLIATH_CAPTCHA_PROVIDER=capsolver   # or 2captcha
export GOLIATH_CAPTCHA_KEY=your_api_key
export GOLIATH_CAPTCHA_OCR=1                # enable tesseract OCR for text CAPTCHAs
```

## Usage

```bash
# Detect, solve, and submit a CAPTCHA on tab abc123
curl -X POST http://localhost:9377/tabs/abc123/solve-captcha \
  -H "Content-Type: application/json" \
  -d '{"userId": "agent1"}'
```

Response:

```json
{
  "ok": true,
  "captchaType": "recaptcha-v2",
  "solver": "capsolver",
  "submitted": true,
  "url": "https://www.doordash.com/..."
}
```

## Supported challenges

| Type | Detection | Solver |
|------|-----------|--------|
| reCAPTCHA v2 | `.g-recaptcha`, `iframe[src*="recaptcha"]` | 2captcha / capsolver |
| hCaptcha | `.h-captcha` | 2captcha / capsolver |
| Cloudflare Turnstile | `.cf-turnstile` | 2captcha |
| Text / image CAPTCHA | `img[src*="captcha"]` + answer input | tesseract OCR |

## Failure cases

- `No supported CAPTCHA detected` — the page isn't presenting a known challenge.
- Could not solve / provider errors — check `GOLIATH_CAPTCHA_KEY` and provider.
- Anti-bot systems may still reject a session; Goliath does not guarantee CAPTCHA
  acceptance (see project DISCLOSURE).

## Architecture

- `index.js` — route handler (`POST /tabs/:tabId/solve-captcha`), detect → solve → fill → submit
- `captcha.js` — solver logic, env reads, and `child_process` (tesseract) isolated here

Built by Mechanica Labs. First implementation for the Doordash/anti-bot use case.
