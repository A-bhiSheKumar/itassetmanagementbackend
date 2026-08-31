import type { Request, Response } from 'express';
import { isDatabaseHealthy } from '../../core/db/index.js';
import { ok } from '../../core/http/index.js';

/**
 * Two endpoints, two different questions (docs/02-architecture.md §13):
 *
 *   /health/live   — is the process up? Never checks dependencies. If this
 *                    fails the orchestrator restarts the container.
 *   /health/ready  — can it serve traffic? Checks Mongo and Redis. If this
 *                    fails the load balancer takes the replica out of rotation
 *                    without killing it.
 *
 * Conflating them causes a database blip to restart every replica at once.
 */

export function live(_req: Request, res: Response): void {
  ok(res, { status: 'ok', uptime: Math.round(process.uptime()) });
}

export function ready(_req: Request, res: Response): void {
  const checks = {
    database: isDatabaseHealthy(),
  };

  const healthy = Object.values(checks).every(Boolean);

  if (!healthy) {
    res.status(503).json({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Not ready to serve traffic.', details: checks },
    });
    return;
  }

  ok(res, { status: 'ready', checks });
}
