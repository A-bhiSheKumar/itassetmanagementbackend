import type { Request, Response, NextFunction } from 'express';
import { metrics } from './metrics.js';
import { logger } from '../logging/index.js';

/**
 * Times every request and records it against its route PATTERN.
 *
 * ── Why the pattern has to be reconstructed ───────────────────────────────
 * `req.route.path` gives the leaf pattern (`/assign`), and `req.baseUrl` gives
 * the matched URL PREFIX — not the pattern. For a router mounted at
 * `/assets/:id`, baseUrl is `/api/v1/assets/6a94f3…`, so naively joining them
 * yields `route="/api/v1/assets/6a94f3…/assign"`: one metric series per asset.
 *
 * Unbounded label cardinality is the standard way to take down a metrics
 * backend, and it is invisible until the series count explodes. Identifier-
 * shaped segments are normalised back to `:id`.
 */

/** Above this, a request is worth a log line of its own. */
const SLOW_REQUEST_MS = 1_000;

/** Mongo ObjectId, ULID, and UUID — every id shape this API hands out. */
const ID_SEGMENT =
  /^([0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function toPattern(baseUrl: string, routePath: string): string {
  const normalised = baseUrl
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');

  // A leaf of '/' would double the slash.
  return routePath === '/' ? normalised || '/' : `${normalised}${routePath}`;
}

export function requestMetrics(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    // Resolved on finish, not on entry: the route is only known once Express
    // has matched it, and an unmatched request has no pattern at all.
    const route = req.route as { path?: string } | undefined;
    const pattern = route?.path !== undefined ? toPattern(req.baseUrl, route.path) : 'unmatched';

    metrics.observeRequest(req.method, pattern, res.statusCode, durationMs);

    if (durationMs > SLOW_REQUEST_MS) {
      // Logged with the ambient context, so a slow request can be traced to the
      // tenant it belonged to.
      logger.warn(
        {
          route: pattern,
          method: req.method,
          durationMs: Math.round(durationMs),
          status: res.statusCode,
        },
        'Slow request',
      );
    }
  });

  next();
}
