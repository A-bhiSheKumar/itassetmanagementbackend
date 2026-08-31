import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';

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
