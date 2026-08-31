import { Router } from 'express';
import { markPublic } from '../../core/authz/index.js';
import { asyncHandler } from '../../core/http/index.js';
import { live, ready, prometheus, summary } from './health.controller.js';

export const healthRoutes = Router();

// Explicitly public. The load balancer polls these before any token exists —
// but "public" has to be a decision someone made, not a guard someone forgot,
// which is what tests/security/routeGuards.test.ts enforces.
healthRoutes.get('/live', markPublic(), live);
healthRoutes.get('/ready', markPublic(), ready);

/**
 * Metrics are PUBLIC in the same sense the health checks are: a scraper has no
 * session, and these carry no tenant data — route patterns, counts and
 * latencies only, never ids or names.
 *
 * They should still be unreachable from the internet. That is a network
 * decision (bind the scrape port internally, or deny /metrics at the edge),
 * not something a bearer token would solve for a Prometheus scraper.
 */
healthRoutes.get('/metrics', markPublic(), asyncHandler(prometheus));
healthRoutes.get('/summary', markPublic(), summary);
