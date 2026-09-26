import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler, asyncHandler } from '../../src/core/http/index.js';

/**
 * How the API behaves when the parts underneath it fail.
 *
 * These are the conditions nobody can reproduce on demand — the database
 * unreachable, a query abandoned, two transactions colliding — and exactly the
 * ones that turn into an unhelpful 500 if nothing maps them. Asserted here at
 * the middleware, because they cannot be provoked through a healthy stack.
 */
function appThrowing(error: unknown) {
  const app = express();
  app.get(
    '/boom',
    asyncHandler(async () => {
      throw error;
    }),
  );
  app.use(errorHandler);
  return app;
}

const codeError = (code: number, codeName: string) => Object.assign(new Error(codeName), { code, codeName });

describe('when the database is unreachable', () => {
  it('answers 503 and invites a retry, rather than a bare 500', async () => {
    // By name, as the handler matches it: the driver's own class cannot be
    // constructed without a topology, and a second copy of the driver would
    // fail an instanceof check anyway.
    const unreachable = Object.assign(new Error('no primary available'), { name: 'MongoServerSelectionError' });
    const res = await request(appThrowing(unreachable)).get('/boom');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).toContain('try again');
  });
});

describe('when a read hits its time ceiling', () => {
  it('says so, and suggests narrowing the request', async () => {
    const res = await request(appThrowing(codeError(50, 'MaxTimeMSExpired'))).get('/boom');

    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('narrowing');
  });
});

describe('when two writes collide', () => {
  it('is a 409 that says nothing was saved', async () => {
    const res = await request(appThrowing(codeError(112, 'WriteConflict'))).get('/boom');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Nothing was saved');
  });
});

describe('a malformed request body', () => {
  it('is a validation failure, not a crash', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', (_req, res) => res.json({ success: true, data: null }));
    app.use(errorHandler);

    const res = await request(app).post('/echo').set('Content-Type', 'application/json').send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
