import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import {
  collectRoutes,
  tenantScopedRoutes,
  fillParams,
  hasRecordIdParam,
} from '../helpers/routeTable.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { useSharedFixtures } from '../setup.js';

/**
 * Route-level tenant isolation — the highest-value suite in the project.
 *
 * GENERATED from the route table, not hand-written. Every tenant-scoped route
 * is exercised with tenant A's credentials against tenant B's data. A new
 * endpoint is covered the moment it is registered, which is the whole point:
 * a hand-maintained version is one forgotten pull request away from being a
 * false sense of security.
 */
const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);
const routes = tenantScopedRoutes(collectRoutes(app));

let alpha: SeededTenant;
let beta: SeededTenant;

/**
 * Seeded once for the whole file.
 *
 * Every test here is a probe that must FAIL — a foreign id, a forged token, a
 * cross-tenant read — so nothing mutates the fixtures and they can be shared.
 * Re-registering two complete tenants per test made this suite dominate the
 * run for no benefit.
 */
useSharedFixtures();

beforeAll(async () => {
  await ensurePlansSeeded();
  alpha = await seedTenant(server(), 'alpha');
  beta = await seedTenant(server(), 'beta');
});

describe('route-level tenant isolation', () => {
  it('has tenant-scoped routes to check', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  // Routes addressing a specific record: the IDOR surface.
  const parameterised = routes.filter((r) => hasRecordIdParam(r.path));

  it.each(parameterised.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s cannot reach another tenant’s record',
    async (_label, route) => {
      // A real, valid id — belonging to the other tenant. The classic IDOR.
      const path = fillParams(route.path, beta.membershipId);

      const res = await request(server())
        [route.method.toLowerCase() as 'get'](path)
        .set('Authorization', `Bearer ${alpha.accessToken}`)
        .send({});

      expect(
        res.status,
        `${route.method} ${path} returned ${res.status} for a foreign record. ` +
          'It must not succeed.',
      ).not.toBeLessThan(400);

      // 404 rather than 403: a 403 confirms the record exists, which turns the
      // endpoint into an enumeration oracle (ADR-015).
      expect([404, 422]).toContain(res.status);
    },
  );

  // Everything else that reads: collections, plus value-parameter routes like
  // /lifecycle/transitions/:from. They cannot be probed with a foreign id, but
  // they must still never return another tenant's data.
  const collections = routes.filter((r) => r.method === 'GET' && !hasRecordIdParam(r.path));

  it.each(collections.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s returns no trace of another tenant',
    async (_label, route) => {
      const res = await request(server())
        .get(fillParams(route.path, 'in_stock'))
        .set('Authorization', `Bearer ${alpha.accessToken}`);

      if (res.status >= 400) return; // permission-denied is also isolation

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(beta.tenantId);
      expect(body).not.toContain(beta.userId);
      if (beta.membershipId) expect(body).not.toContain(beta.membershipId);
    },
  );
});

describe('token scoping', () => {
  it('rejects a request with no token on a guarded route', async () => {
    const res = await request(server()).get('/api/v1/members');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const res = await request(server())
      .get('/api/v1/members')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign(
      { scope: 'tenant', tid: beta.tenantId, mid: beta.membershipId, pv: 0, tv: 0, jti: 'x' },
      'an-attacker-controlled-secret-of-sufficient-length',
      { subject: beta.userId, issuer: 'itam', expiresIn: '15m' },
    );

    const res = await request(server()).get('/api/v1/members').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an alg:none token', async () => {
    // The classic JWT bypass: strip the signature and claim no algorithm.
    // verifyAccessToken pins algorithms: ['HS256'] specifically to kill this.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        scope: 'tenant',
        sub: beta.userId,
        tid: beta.tenantId,
        mid: beta.membershipId,
        pv: 0,
        tv: 0,
        iss: 'itam',
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');

    const res = await request(server())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${header}.${payload}.`);

    expect(res.status).toBe(401);
  });

  it('refuses a user-scoped token on a tenant route', async () => {
    // Login yields a token that can list organisations and select one, and
    // nothing else. It must not be usable as a tenant token.
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: alpha.email, password: alpha.password });

    const res = await request(server())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);

    expect(res.status).toBe(401);
  });

  it('refuses tenant selection for an organisation you do not belong to', async () => {
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: alpha.email, password: alpha.password });

    const res = await request(server())
      .post('/api/v1/auth/select-tenant')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ tenantId: beta.tenantId });

    // 404, not 403 — otherwise this endpoint enumerates our customer list.
    expect(res.status).toBe(404);
  });
});
