import type { Request, Response } from 'express';
import { isDatabaseHealthy } from '../../core/db/index.js';
import { ok } from '../../core/http/index.js';
import { metrics, getErrorReporter, LoggingErrorReporter } from '../../core/telemetry/index.js';
import { getJobQueue } from '../../core/jobs/index.js';
import { logger } from '../../core/logging/index.js';

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

/**
 * Prometheus scrape target.
 *
 * Text, not the JSON envelope — a scraper expects the exposition format and
 * nothing else. Per-replica by nature; aggregating across replicas is the
 * scraper's job.
 */
export async function prometheus(_req: Request, res: Response): Promise<void> {
  await refreshQueueGauges();

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.render());
}

/**
 * Reads queue depth at scrape time rather than on a timer.
 *
 * A timer would make every sample up to one interval stale, and staleness is
 * exactly what breaks a backlog alert: the depth that matters is the one now.
 *
 * A failure here must not fail the scrape. Losing the queue gauges for one
 * interval is a gap in a graph; returning 500 blinds the scraper to error rate
 * and latency too, which is how a monitoring endpoint becomes the reason an
 * outage goes unnoticed.
 */
async function refreshQueueGauges(): Promise<void> {
  try {
    for (const depth of await getJobQueue().stats()) {
      const labels = { queue: depth.queue };
      metrics.setGauge('queue_waiting', depth.waiting, labels);
      metrics.setGauge('queue_active', depth.active, labels);
      metrics.setGauge('queue_delayed', depth.delayed, labels);
      metrics.setGauge('queue_dead_lettered', depth.failed, labels);
    }
  } catch (err) {
    logger.warn({ err }, 'Could not read queue depth for metrics');
  }
}

/** The same numbers, readable, for a human or a status page. */
export function summary(_req: Request, res: Response): void {
  const reporter = getErrorReporter();

  ok(res, {
    ...metrics.summary(),
    errorReporter: reporter.name,
    ...(reporter instanceof LoggingErrorReporter ? { reportedErrors: reporter.snapshot() } : {}),
  });
}
