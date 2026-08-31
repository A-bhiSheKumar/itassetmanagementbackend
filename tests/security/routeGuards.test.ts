import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { collectRoutes } from '../helpers/routeTable.js';

/**
 * Every route must declare how it is guarded.
 *
 * This is the suite that stops an endpoint shipping unauthenticated by
 * omission. Adding a route without requirePermission(), requireAuth() or
 * markPublic() fails the build — it is not possible to forget quietly.
 */
const routes = collectRoutes(createApp());

describe('route guards', () => {
  it('finds routes to check', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it.each(routes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s declares a guard',
    (_label, route) => {
      const guard = route.guard;

      expect(
        guard,
        `${route.method} ${route.path} has no guard. Add requirePermission(...), ` +
          'requireAuth() or markPublic() — being public must be a decision, not an omission.',
      ).toBeDefined();

      const declared =
        guard?.permission !== undefined || guard?.public === true || guard?.authenticatedOnly === true;

      expect(declared).toBe(true);
    },
  );

  it('keeps the public surface small and deliberate', () => {
    const publicPaths = routes
      .filter((r) => r.guard?.public)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    // A snapshot with intent: any change to what is reachable without a token
    // should be a visible, argued-for diff in review — never a side effect.
    // Sorted, so the assertion is stable; each entry carries the reason it is
    // reachable without a token.
    expect(publicPaths).toEqual([
      // Presigned download — authorised by an expiring HMAC in the URL, exactly
      // as an S3 presigned GET is. The local stand-in for object storage.
      'GET /api/v1/documents/download',
      // Polled by the load balancer, before any token exists.
      'GET /api/v1/health/live',
      // Scrape target. Carries route patterns, counts and latencies — never a
      // tenant id, a record id or a name. Kept off the internet at the network
      // layer, not with a token a Prometheus scraper cannot present.
      'GET /api/v1/health/metrics',
      'GET /api/v1/health/ready',
      'GET /api/v1/health/summary',
      // Credential endpoints: by definition reached without a session.
      'POST /api/v1/auth/accept-invitation',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/register',
      // The presigned upload that pairs with the download above.
      'PUT /api/v1/documents/upload',
    ]);
  });

  it('only ever uses permissions that exist in the registry', async () => {
    const { ALL_PERMISSIONS } = await import('../../src/core/authz/index.js');

    for (const route of routes) {
      if (!route.guard?.permission) continue;
      expect(
        ALL_PERMISSIONS as readonly string[],
        `${route.method} ${route.path} requires "${route.guard.permission}", which is not in the registry.`,
      ).toContain(route.guard.permission);
    }
  });
});
