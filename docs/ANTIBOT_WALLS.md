# Anti-bot walls

PerimeterX (HUMAN), DataDome and Cloudflare classify the network before they
weigh the browser: a page can render fully, fields fill and verify, and every
real interaction is still swallowed with no request leaving the browser. Goliath
detects that state, drives a visible challenge through the native input layer,
records which egress profile clears which vendor, and returns a typed verdict so
an agent routes around a dead end instead of retrying into it.

## States

`GET /tabs/{tabId}/wall?userId=...` reports the wall on the current page.

| state | meaning |
| --- | --- |
| `none` | No anti-bot vendor is present on the page. |
| `clear` | A vendor is present but the page is usable (ordinary tagging). |
| `challenge` | A visible challenge is waiting: `kind: frame-challenge` or `kind: press-hold`. |
| `silent` | The vendor marked the page and nothing usable came back (`kind: silent-block`). |

The same object is attached as `wall` to `navigate`, `click` and `snapshot`
responses. When `wall.blocking` is true those responses also carry the typed
verdict code, for example `perimeterx:blocked`, `datadome:blocked` or
`cloudflare:blocked`.

## Routes

- `GET /tabs/{tabId}/wall` — current wall state and the egress profile in use.
- `POST /tabs/{tabId}/wall/solve` — drives a visible challenge with the humanized
  input layer (real pointer path, real press-and-hold cadence). Returns
  `outcome: cleared`, `outcome: blocked` with the typed code, or
  `outcome: not-applicable` when no wall is present. A challenge is never solved
  with an injected JavaScript click, which vendors fingerprint.
- `GET /egress` — the active egress profile, every configured profile (credentials
  withheld), the recorded outcome matrix, and current dead ends.

## Egress profiles

Anti-bot pressure is a property of the network, so the durable lever is which
egress the fleet uses. Profiles are named and carry a network class.

```bash
export GOLIATH_EGRESS_PROFILES='[
  {"name":"dc-1","class":"datacenter","server":"proxy.example.com:8000","username":"u","password":"p"},
  {"name":"res-ae","class":"residential","server":"res.example.com:9000","country":"AE"}
]'
export GOLIATH_EGRESS_STATE_DIR=~/.goliath     # outcome record: egress-profiles.json
```

Without `GOLIATH_EGRESS_PROFILES` the existing `PROXY_*` configuration becomes a
single profile named by `GOLIATH_EGRESS_PROFILE_NAME` (default `default`), with
its class taken from `GOLIATH_EGRESS_CLASS`. Every blocked wall is recorded
against the active profile; once a profile has blocked a vendor twice with no
clear, it is reported as a dead end and the fleet selects the next best profile
(recorded clears first, then residential and mobile over datacenter) for the
following browser launch. `GET /egress` shows the resulting matrix, which is the
record of what clears and what does not.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOLIATH_EGRESS_PROFILES` | unset | Inline JSON array of egress profiles. |
| `GOLIATH_EGRESS_PROFILES_FILE` | unset | Path to the same JSON instead of inline. |
| `GOLIATH_EGRESS_PROFILE_NAME` | `default` | Name given to the `PROXY_*` fallback profile. |
| `GOLIATH_EGRESS_CLASS` | `unknown` | Network class of the fallback profile: `datacenter`, `residential`, `mobile`. |
| `GOLIATH_EGRESS_STATE_DIR` | `~/.goliath` | Where the outcome record is written. |
| `GOLIATH_EGRESS_AUTOROTATE` | `1` | Set `0` to keep the active profile fixed. |
| `GOLIATH_ANTIBOT_DETECT` | `1` | Set `0` to skip wall detection on navigation. |
| `GOLIATH_ANTIBOT_DRIVE` | `1` | Set `0` to report walls without driving challenges. |

## What was observed, and where

Verified with the native engine (Camoufox, headless) from a Dubai residential
connection (AS5384):

| Site | Vendor | Observed |
| --- | --- | --- |
| zillow.com | PerimeterX (`PXHYx10rg3`) | HTTP 403, no challenge frame, `_pxvid`/`_px3` cookies, zero interactive elements, "Press & Hold to confirm you are a human". Detected as `challenge` / `press-hold`. |
| etsy.com | PerimeterX | Interstitial requested *after* an interaction (`geo.captcha-delivery.com/interstitial/`, `ct.captcha-delivery.com/i.js`), which is why detection also runs after clicks rather than only on load. |
| login.standvirtual.com (OLX identity) | DataDome + AWS WAF | No PerimeterX anywhere on the property; the login page loads normally with an email and password form. |
| airbnb.ae | DataDome | No PerimeterX. |

The practical consequence: a `silent` verdict from a datacenter network class is
a dead end for that pair, and the fleet should switch egress rather than retry.
The matrix from `GET /egress` is the fleet's own record of that.

## Repro

`tests/fixtures/antibot-fixture.js` serves the three page shapes from loopback:
`/px-challenge` (visible PerimeterX-style frame), `/px-silent` (403 with an `x-px`
header, vendor markers, and a form whose submission goes nowhere) and `/clean`.
Unit coverage lives in `tests/unit/antibot.test.js`,
`tests/unit/antibot-routes.test.js` and `tests/unit/egress-profile.test.js`.
