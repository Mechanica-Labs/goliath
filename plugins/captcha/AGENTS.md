# Captcha plugin — agent-guide

Automate solving CAPTCHA walls inside Goliath's browser so agents can carry on
past anti-bot checks (e.g. Doordash, ticket sites, login pages).

## Endpoints

- `POST /tabs/:tabId/solve-captcha` — detect, solve, and fill a CAPTCHA on the
  current page, then submit it.

Enable the plugin in `goliath.config.json`:
```json
{
  "plugins": {
    "captcha": { "enabled": true }
  }
}
```

## How it works

1. **Detect** the challenge type on the page:
   - reCAPTCHA v2 checkbox (`g-recaptcha`, `cf-challenge`, iframe `g-recaptcha`)
   - hCaptcha (`h-captcha`)
   - Cloudflare Turnstile (`cf-turnstile`)
   - Text/image CAPTCHA (`img` with `captcha` in class/alt/src, or `[captcha]`)
2. **Solve** it using either:
   - an external solver API (`GOLIATH_CAPTCHA_KEY` + `GOLIATH_CAPTCHA_PROVIDER`,
     supported: `2captcha`, `capsolver`), or
   - local OCR as a fallback for text/image challenges (`tesseract`).
3. **Fill + submit**: type the resolved token into the answer field and click
   the submit/verify button.

## Configuration (env vars)

| Var | Purpose |
|-----|---------|
| `GOLIATH_CAPTCHA_PROVIDER` | `2captcha` (default) or `capsolver` |
| `GOLIATH_CAPTCHA_KEY` | API key for the solver provider |
| `GOLIATH_CAPTCHA_OCR` | `1` to allow local tesseract OCR fallback |
| `GOLIATH_CAPTCHA_TIMEOUT_MS` | Solver poll timeout (default 120000) |
| `GOLIATH_CAPTCHA_SITEKEY` | Optional explicit site-key override |

## Response

`POST /tabs/:tabId/solve-captcha` returns:

```json
{
  "ok": true,
  "captchaType": "recaptcha-v2",
  "solver": "capsolver",
  "submitted": true,
  "url": "https://www.doordash.com/..."
}
```

If the challenge cannot be detected or solved, `ok` is `false` with an `error`
message. Goliath does not guarantee a CAPTCHA or anti-bot system will accept a
session — see the project DISCLOSURE.

## Files

- `index.js` — route handler (no `child_process`, no `process.env` reads)
- `captcha.js` — solver logic (provider HTTP + OCR; `child_process` isolated here
  for tesseract, `process.env` reads centralized here)
- `apt.txt` — system deps (`tesseract-ocr`)
- `captcha.test.js` — unit tests
- `README.md`, `AGENTS.md` — this guide

## Code separation

Per project convention: route handlers in `index.js`, `child_process` and env
reads in `captcha.js`. Never mix them.

## Original contributors

Mechanica Labs — first implementation for the Doordash/anti-bot use case.
