import { describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from './app.js';
import type { Db } from './store/db.js';
import { fakeAdmin, fakeIngress, silentLogger } from './testing/restate.js';

/**
 * The HTTP layer as wired: the security guards, the error envelope and readiness. The rules
 * themselves are tested against the domain, and the serialization contract in `routes/*.test.ts`.
 */
function app(overrides: { dbOk?: boolean; restateOk?: boolean } = {}) {
  const db = {
    query: async () =>
      overrides.dbOk === false ? Promise.reject(new Error('down')) : { rows: [], rowCount: 0 },
  };
  const deps: AppDeps = {
    db: db as unknown as Db,
    admin: fakeAdmin({ health: async () => overrides.restateOk ?? true }),
    ingress: fakeIngress(),
    kafka: { cluster: 'local', bootstrapServers: 'kafka:9092' },
    log: silentLogger(),
    allowedHosts: ['localhost', '127.0.0.1', 'core-api'],
  };
  return buildApp(deps);
}

describe('readiness', () => {
  it('is ready only when both stores answer', async () => {
    const up = await app().inject({ url: '/health/ready', headers: { host: 'localhost' } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({
      status: 'ready',
      dependencies: { postgres: true, restate: true },
    });

    const down = await app({ restateOk: false }).inject({
      url: '/health/ready',
      headers: { host: 'localhost' },
    });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({
      status: 'not_ready',
      dependencies: { postgres: true, restate: false },
    });
  });

  it('reports Postgres being unreachable without crashing', async () => {
    const res = await app({ dbOk: false }).inject({
      url: '/health/ready',
      headers: { host: 'localhost' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().dependencies).toEqual({ postgres: false, restate: true });
  });
});

describe('host guard', () => {
  it('rejects unknown Host headers (DNS rebinding) but accepts the compose name', async () => {
    const evil = await app().inject({
      url: '/health/live',
      headers: { host: 'evil.example:3000' },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toEqual({
      error: { code: 'INVALID_HOST', message: 'Host is not allowed' },
    });
    expect(
      (await app().inject({ url: '/health/live', headers: { host: 'core-api:3000' } })).statusCode,
    ).toBe(200);
  });

  it('refuses cross-site writes but not same-origin or non-browser callers', async () => {
    const post = (headers: Record<string, string>) =>
      app().inject({
        method: 'POST',
        url: '/v1/runs/content-enrichment/api_x/cancel',
        headers: { host: 'localhost:3000', ...headers },
      });
    expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).json().error.code).toBe(
      'CROSS_SITE_REQUEST',
    );
    // Allowed origins and CLI/curl (no Origin) pass the guard, then fail later on the stub store.
    expect((await post({ origin: 'http://localhost:3000' })).statusCode).not.toBe(403);
    expect((await post({})).statusCode).not.toBe(403);
  });
});

describe('error envelope', () => {
  it('wraps unknown routes, invalid params and invalid bodies', async () => {
    const missing = await app().inject({ url: '/nope', headers: { host: 'localhost' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ROUTE_NOT_FOUND');

    const badName = await app().inject({
      url: '/v1/workflows/Bad_Name',
      headers: { host: 'localhost' },
    });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error.code).toBe('INVALID_REQUEST');

    const badBody = await app().inject({
      method: 'POST',
      url: '/v1/workflows/content-enrichment/runs',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: { input: {}, extra: 1 },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('INVALID_REQUEST');
  });

  it('reports malformed JSON as a client error, not a crash', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/v1/workflows/content-enrichment/runs',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });
});
