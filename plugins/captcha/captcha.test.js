/**
 * Unit tests for the captcha plugin solver.
 * Tests config resolution and detection logic with mocked Playwright pages;
 * provider HTTP is exercised through injected fetch mocks.
 */
import { jest } from '@jest/globals';
import {
  resolveCaptchaConfig,
  detectCaptcha,
  __internals,
} from './captcha.js';

const { postJson, solve2captcha, solveCapsolver } = __internals;

describe('resolveCaptchaConfig', () => {
  it('reads defaults from env', async () => {
    const cfg = await resolveCaptchaConfig({}, {
      GOLIATH_CAPTCHA_PROVIDER: '2captcha',
      GOLIATH_CAPTCHA_KEY: 'abc',
      GOLIATH_CAPTCHA_OCR: '1',
    });
    expect(cfg.provider).toBe('2captcha');
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.ocrenabled).toBe(true);
    expect(cfg.timeoutMs).toBe(120000);
  });

  it('plugin config overrides env', async () => {
    const cfg = await resolveCaptchaConfig(
      { provider: 'capsolver', apiKey: 'xyz', ocr: false },
      { GOLIATH_CAPTCHA_PROVIDER: '2captcha', GOLIATH_CAPTCHA_KEY: 'abc' },
    );
    expect(cfg.provider).toBe('capsolver');
    expect(cfg.apiKey).toBe('xyz');
    expect(cfg.ocrenabled).toBe(false);
  });
});

describe('detectCaptcha', () => {
  it('detects reCAPTCHA v2 from .g-recaptcha data-sitekey', async () => {
    const page = {
      evaluate: jest.fn(async () => ({
        kind: 'recaptcha-v2',
        siteKey: '6LcEXAMPLE',
        url: 'https://www.example.com/login',
      })),
    };
    const d = await detectCaptcha(page);
    expect(d.kind).toBe('recaptcha-v2');
    expect(d.siteKey).toBe('6LcEXAMPLE');
  });

  it('detects text captcha from image + input selectors', async () => {
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(null) // provider scan
        .mockResolvedValueOnce({
          loc: 'https://example.com/form',
          imageSelector: '#captcha_img',
          inputSelector: '#captcha_input',
        }),
    };
    const d = await detectCaptcha(page);
    expect(d.type).toBe('text');
    expect(d.imageSelector).toBe('#captcha_img');
    expect(d.inputSelector).toBe('#captcha_input');
  });
});

describe('postJson', () => {
  it('posts JSON and returns parsed body', async () => {
    global.fetch = jest.fn(async () => ({
      text: async () => JSON.stringify({ ok: 1 }),
    }));
    const res = await postJson('https://api.test', { a: 1 }, '');
    expect(res.ok).toBe(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('solve2captcha', () => {
  it('polls until ready and returns token', async () => {
    const cfg = { apiKey: 'key', timeoutMs: 60000 };
    const detected = { kind: 'recaptcha-v2', siteKey: 'sk', url: 'https://x.com' };

    let calls = 0;
    global.fetch = jest.fn(async (url, opts) => {
      if (url.includes('/in.php')) {
        return { text: async () => JSON.stringify({ taskId: 123 }) };
      }
      // res.php
      calls++;
      const payload = { status: 0, request: 'CAPCHA_NOT_READY' };
      if (calls >= 2) payload.status = 1, payload.request = 'TOKEN123';
      return { text: async () => JSON.stringify(payload) };
    });

    const realTimer = global.setTimeout;
    global.setTimeout = jest.fn((fn) => { fn(); return 1; }) // instant poll
      ;

    try {
      const r = await solve2captcha(cfg, detected);
      expect(r.token).toBe('TOKEN123');
      expect(r.solver).toBe('2captcha');
    } finally {
      global.setTimeout = realTimer;
    }
  });
});

describe('solveCapsolver', () => {
  it('returns token when status ready', async () => {
    const cfg = { apiKey: 'key', timeoutMs: 60000 };
    const detected = { kind: 'recaptcha-v2', siteKey: 'sk', url: 'https://x.com' };

    let calls = 0;
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/createTask')) {
        return { text: async () => JSON.stringify({ taskId: 'abc' }) };
      }
      calls++;
      const body = calls >= 2
        ? { status: 'ready', solution: { gRecaptchaResponse: 'CAPTOKEN' } }
        : { status: 'processing' };
      return { text: async () => JSON.stringify(body) };
    });

    const realTimer = global.setTimeout;
    global.setTimeout = jest.fn((fn) => { fn(); return 1; });
    try {
      const r = await solveCapsolver(cfg, detected);
      expect(r.token).toBe('CAPTOKEN');
    } finally {
      global.setTimeout = realTimer;
    }
  });
});
