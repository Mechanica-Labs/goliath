/**
 * Small, dependency-free client for Goliath's REST surface.
 *
 * The benchmark intentionally talks to the public API rather than importing
 * internal modules. That keeps results representative of what an agent or
 * harness actually experiences and makes the same suite usable against a
 * packaged or remote Goliath instance.
 */
export class BenchmarkHttpError extends Error {
  constructor(message, { status, method, path, body } = {}) {
    super(message);
    this.name = 'BenchmarkHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

export class GoliathBenchmarkClient {
  constructor({ baseUrl, userId, sessionKey, timeoutMs = 45_000, token = null }) {
    if (!baseUrl) throw new TypeError('baseUrl is required');
    if (!userId) throw new TypeError('userId is required');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.userId = userId;
    this.sessionKey = sessionKey || 'benchmark';
    this.timeoutMs = timeoutMs;
    this.token = token;
    this.requestCount = 0;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.requestCount += 1;

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : text;
        throw new BenchmarkHttpError(
          `${method} ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`,
          { status: response.status, method, path, body: parsed },
        );
      }

      return parsed ?? {};
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new BenchmarkHttpError(`${method} ${path} timed out after ${this.timeoutMs}ms`, {
          method,
          path,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  health() {
    return this.request('/health');
  }

  createTab(url) {
    return this.request('/tabs', {
      method: 'POST',
      body: {
        userId: this.userId,
        sessionKey: this.sessionKey,
        url,
      },
    });
  }

  snapshot(tabId) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.userId)}`);
  }

  navigate(tabId, url) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: 'POST',
      body: { userId: this.userId, url },
    });
  }

  click(tabId, target) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/click`, {
      method: 'POST',
      body: { userId: this.userId, ...target },
    });
  }

  type(tabId, target, text, extra = {}) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/type`, {
      method: 'POST',
      body: { userId: this.userId, ...target, text, ...extra },
    });
  }

  hands(tabId, steps, extra = {}) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/hands`, {
      method: 'POST',
      body: { userId: this.userId, steps, ...extra },
    });
  }

  evaluate(tabId, expression) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate`, {
      method: 'POST',
      body: { userId: this.userId, expression },
    });
  }

  listTabs() {
    return this.request(`/tabs?userId=${encodeURIComponent(this.userId)}`);
  }

  closeTab(tabId) {
    return this.request(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(this.userId)}`, {
      method: 'DELETE',
    });
  }

  deleteSession() {
    return this.request(`/sessions/${encodeURIComponent(this.userId)}`, {
      method: 'DELETE',
    });
  }
}
