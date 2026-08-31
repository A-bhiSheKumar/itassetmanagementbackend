import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { toPattern } from '../../src/core/telemetry/requestMetrics.middleware.js';

/**
 * HTTP smoke tests.
 *
 * Exercises the real middleware chain — request context, routing, the response
 * envelope, the 404 handler and the error handler — against the actual app,
 * not a mock. This is the boot path a deploy depends on.
 */
const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);

describe('health endpoints', () => {
  it('reports liveness without touching dependencies', async () => {
    const res = await request(server()).get('/api/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('reports readiness with dependency checks', async () => {
    const res = await request(server()).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.checks.database).toBe(true);
  });
});

describe('response envelope', () => {
  it('includes a requestId in the body and the header', async () => {
    const res = await request(server()).get('/api/v1/health/live');

    expect(res.body.meta.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('honours an inbound X-Request-Id so traces survive the gateway', async () => {
    const res = await request(server())
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'trace-from-upstream');

    expect(res.body.meta.requestId).toBe('trace-from-upstream');
  });

  it('gives every request a distinct id', async () => {
    const [a, b] = await Promise.all([
      request(server()).get('/api/v1/health/live'),
      request(server()).get('/api/v1/health/live'),
    ]);

    expect(a.body.meta.requestId).not.toBe(b.body.meta.requestId);
  });
});

describe('error handling', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await request(server()).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.meta.requestId).toBeTruthy();
  });

  it('rejects malformed JSON without leaking a stack trace', async () => {
    const res = await request(server())
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('node_modules');
  });
});

describe('security headers', () => {
  it('sets the headers helmet is mounted for', async () => {
    const res = await request(server()).get('/api/v1/health/live');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    // Advertising the framework and version just helps an attacker pick an exploit.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not reflect an arbitrary CORS origin', async () => {
    const res = await request(server())
      .get('/api/v1/health/live')
      .set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('allows the configured origin', async () => {
    const res = await request(server())
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('telemetry', () => {
  it('exposes Prometheus metrics as text, not as the JSON envelope', async () => {
    await request(server()).get('/api/v1/health/live');

    const res = await request(server()).get('/api/v1/health/metrics');

    expect(res.status).toBe(200);
    // A scraper expects the exposition format and nothing else.
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE itam_requests_total counter');
    expect(res.text).toContain('itam_request_duration_ms_bucket');
  });

  it('records requests against the route PATTERN, never the URL', async () => {
    await request(server()).get('/api/v1/health/live');

    const res = await request(server()).get('/api/v1/health/metrics');

    // A per-id series would be unbounded cardinality — the standard way to take
    // down a metrics backend.
    expect(res.text).toContain('/api/v1/health/live');
    expect(res.text).not.toMatch(/route="[^"]*\/[0-9a-f]{24}/);
  });

  it('counts an unmatched request without inventing a route for it', async () => {
    await request(server()).get('/api/v1/definitely-not-a-route');

    const res = await request(server()).get('/api/v1/health/metrics');
    expect(res.text).toContain('unmatched');
  });

  it('summarises error rate for a human', async () => {
    const res = await request(server()).get('/api/v1/health/summary');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      requests: expect.any(Number),
      errorRate: expect.any(Number),
      errorReporter: 'logging',
    });
  });

  it('does not count a 404 as an error', async () => {
    await request(server()).get('/api/v1/nope');

    const res = await request(server()).get('/api/v1/health/summary');
    // A 404 or a 403 is the system working. Only 5xx is an error worth alerting
    // on, and conflating them makes the alarm useless.
    expect(res.body.data.errorRate).toBe(0);
  });
});

describe('metric label cardinality', () => {
  // A router mounted at /assets/:id gives req.baseUrl as the matched URL, not
  // the pattern — so joining it to req.route.path naively produced one metric
  // series per asset. Asserted directly because reaching the bug through HTTP
  // needs an authenticated request, which this smoke-test file has no tenant for;
  // the suite-wide assertion above is what proves it end to end.
  it('normalises every id shape out of a mounted route prefix', () => {
    expect(toPattern('/api/v1/assets/6a94f3aabbccdd0011223344', '/assign')).toBe(
      '/api/v1/assets/:id/assign',
    );
    expect(toPattern('/api/v1/people/01HQ8XKZ9T4M2NPQRSVWXY3BCD', '/assets')).toBe(
      '/api/v1/people/:id/assets',
    );
    expect(toPattern('/api/v1/imports/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/commit')).toBe(
      '/api/v1/imports/:id/commit',
    );
  });

  it('leaves a pattern that carries no id alone', () => {
    expect(toPattern('/api/v1/assets', '/')).toBe('/api/v1/assets');
    expect(toPattern('/api/v1/assets', '/:id')).toBe('/api/v1/assets/:id');
    expect(toPattern('', '/')).toBe('/');
  });
});
