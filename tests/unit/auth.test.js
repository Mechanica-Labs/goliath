import { accessKeyMiddleware, requireAuth } from '../../lib/auth.js';

function invoke(config, { path = '/tabs', address = '127.0.0.1', token } = {}) {
  const req = {
    path,
    method: 'GET',
    socket: { remoteAddress: address },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const result = { next: false, status: 200, body: null, headers: {} };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    set(name, value) {
      result.headers[name] = value;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  accessKeyMiddleware(config)(req, res, () => {
    result.next = true;
  });
  return result;
}

describe('accessKeyMiddleware', () => {
  test('allows loopback clients when no access key is configured', () => {
    expect(invoke({ accessKey: '' })).toMatchObject({ next: true, status: 200 });
  });

  test('rejects non-loopback clients when no access key is configured', () => {
    expect(invoke({ accessKey: '' }, { address: '10.0.0.20' })).toMatchObject({
      next: false,
      status: 403,
      body: { error: 'GOLIATH_ACCESS_KEY is required unless Goliath is bound to loopback' },
    });
  });

  test('requires a key when the server binds beyond loopback', () => {
    expect(invoke({ accessKey: '', bindHost: '0.0.0.0' })).toMatchObject({
      next: false,
      status: 403,
    });
  });

  test('allows the public health check', () => {
    expect(invoke({ accessKey: '' }, { path: '/health', address: '10.0.0.20' }))
      .toMatchObject({ next: true, status: 200 });
  });

  test('requires and validates the configured bearer token', () => {
    expect(invoke({ accessKey: 'secret' }, { address: '10.0.0.20' }).status).toBe(401);
    expect(invoke({ accessKey: 'secret' }, { address: '10.0.0.20', token: 'wrong' }).status).toBe(401);
    expect(invoke({ accessKey: 'secret' }, { address: '10.0.0.20', token: 'secret' }))
      .toMatchObject({ next: true, status: 200 });
  });
});

describe('requireAuth', () => {
  test('allows sensitive local tools in production when no keys are configured', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const result = { next: false, status: 200 };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json() {
        return this;
      },
    };

    requireAuth({ apiKey: '', accessKey: '', nodeEnv: 'production' })(req, res, () => {
      result.next = true;
    });

    expect(result).toEqual({ next: true, status: 200 });
  });
});
