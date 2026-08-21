/**
 * Shared auth middleware for goliath.
 *
 * Extracts the duplicated auth pattern from cookie/storage_state endpoints
 * into a reusable Express middleware factory.
 *
 * Policy (requireAuth / per-route):
 *   - If GOLIATH_API_KEY is set, require Bearer token match (timing-safe).
 *   - If GOLIATH_ACCESS_KEY is set, also accept it as an alternative (superkey).
 *   - If neither key is set, allow loopback (127.0.0.1 / ::1).
 *   - Otherwise, reject.
 *
 * Policy (accessKeyMiddleware / global):
 *   - If GOLIATH_ACCESS_KEY is set, require Bearer match on all routes except
 *     /health, cookie import (when GOLIATH_API_KEY set), and /stop (when GOLIATH_ADMIN_KEY set).
 *   - If no access key is set, only loopback clients may use browser-control routes.
 *   - /health remains public for container health checks.
 */

import crypto from 'crypto';

/**
 * Timing-safe string comparison.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check if an address is loopback.
 */
function isLoopbackAddress(address) {
  if (!address) return false;
  return address === 'localhost' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Create an Express middleware that enforces API key auth.
 *
 * Accepts GOLIATH_API_KEY as primary token. When GOLIATH_ACCESS_KEY is also
 * configured, it is accepted as an alternative ("superkey") so that routes
 * gated by both the global access-key middleware AND this per-route middleware
 * don't require two different tokens in a single Authorization header.
 *
 * @param {object} config - Must have { apiKey, nodeEnv }; optionally { accessKey }
 * @param {object} [options]
 * @param {string} [options.errorMessage] - Custom error message when rejecting unauthenticated requests
 * @returns {function} Express middleware (req, res, next)
 */
export function requireAuth(config, options = {}) {
  const errorMessage = options.errorMessage ||
    'This endpoint requires GOLIATH_API_KEY except for loopback requests.';

  return function requireAuthCheck(req, res, next) {
    const auth = String(req.headers['authorization'] || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1]?.trim() : null;

    // Accept API key
    if (config.apiKey && token && timingSafeCompare(token, config.apiKey)) {
      return next();
    }

    // Accept access key as alternative (superkey)
    if (config.accessKey && token && timingSafeCompare(token, config.accessKey)) {
      return next();
    }

    // If any key is configured, a valid token was required -- reject
    if (config.apiKey || config.accessKey) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // No keys configured -- the global middleware already limits the server to loopback.
    const remoteAddress = req.socket?.remoteAddress || '';
    const allowUnauthedLocal = isLoopbackAddress(remoteAddress);
    if (!allowUnauthedLocal) {
      return res.status(403).json({ error: errorMessage });
    }

    next();
  };
}

/**
 * Global access-key middleware factory.
 *
 * When GOLIATH_ACCESS_KEY is set, requires `Authorization: Bearer <key>` on
 * every route except:
 *   - GET /health (Docker/Fly healthcheck)
 *   - POST /sessions/:userId/cookies (only when GOLIATH_API_KEY is also set -- has its own gate)
 *   - POST /stop (only when GOLIATH_ADMIN_KEY is also set -- has its own gate)
 *
 * When a route's dedicated key is NOT configured, the access-key middleware
 * does NOT exempt it -- defense-in-depth prevents unprotected endpoints.
 *
 * Without a key, only a loopback-bound server serving a loopback client is allowed.
 *
 * @param {object} config - Must have { accessKey }; optionally { apiKey, adminKey }
 * @returns {function} Express middleware (req, res, next)
 */
export function accessKeyMiddleware(config) {
  return function accessKeyCheck(req, res, next) {
    // Exempt healthcheck
    if (req.path === '/health') return next();

    if (!config.accessKey) {
      const remoteAddress = req.socket?.remoteAddress || '';
      const bindHost = config.bindHost || '127.0.0.1';
      if (isLoopbackAddress(bindHost) && isLoopbackAddress(remoteAddress)) return next();
      return res.status(403).json({
        error: 'GOLIATH_ACCESS_KEY is required unless Goliath is bound to loopback',
      });
    }

    // Exempt routes with their own dedicated auth -- but only when their key is configured.
    // If the dedicated key is NOT set, the access key gates the route (defense-in-depth).
    if (config.apiKey && req.method === 'POST' && /^\/sessions\/[^/]+\/cookies$/.test(req.path)) return next();
    if (config.adminKey && req.method === 'POST' && req.path === '/stop') return next();

    const auth = String(req.headers['authorization'] || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1]?.trim() : null;
    if (!token || !timingSafeCompare(token, config.accessKey)) {
      return res.status(401)
        .set('WWW-Authenticate', 'Bearer realm="goliath"')
        .json({ error: 'Unauthorized' });
    }
    next();
  };
}

// Re-export utilities so server.js can still use them directly
export { timingSafeCompare, isLoopbackAddress };
