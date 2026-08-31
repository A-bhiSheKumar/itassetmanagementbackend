import { QUEUE, getJobQueue } from './core/jobs/index.js';
import { dispatchPending } from './core/events/index.js';
import { logger } from './core/logging/index.js';
import {
  rebuildAllMetrics,
  scanExpiringWarranties,
  sweepStorage,
  reconcileAll,
} from './modules/reports/index.js';
import { registerImportJobHandler } from './modules/imports/index.js';

/**
 * The composition root for background work.
 *
 * Lives here rather than in core/jobs because core is framework and must not
 * import a module — the same rule that puts event subscribers in subscribers.ts.
 *
 * Handlers are registered by the WORKER; the API only ever produces. That split
 * is what stops a job running on six API replicas at once.
 */

const OUTBOX_DRAIN_MS = 5_000;
const NIGHTLY_MS = 60 * 60_000;

export function registerJobHandlers(): void {
  const queue = getJobQueue();

  /**
   * Drains anything an HTTP request could not deliver inline — a subscriber
   * that failed, or a process that died between commit and flush.
   */
  queue.register(
    QUEUE.outbox,
    async ({ limit }) => {
      const delivered = await dispatchPending(limit ?? 100);
      if (delivered > 0) logger.debug({ delivered }, 'Outbox drained');
    },
    1, // Single consumer: concurrent drains would fight over the same rows.
  );

  queue.register(QUEUE.scheduled, async ({ task }) => {
    // Before the rollup: it counts assigned assets, and reconciling afterwards
    // would leave the dashboard reporting yesterday's drift for a day.
    if (task === 'reconcile' || task === 'all') await reconcileAll({ repair: true });
    if (task === 'metrics' || task === 'all') await rebuildAllMetrics();
    if (task === 'warranties' || task === 'all') await scanExpiringWarranties();
    if (task === 'storage-sweep' || task === 'all') await sweepStorage();
  });

  // Import commits: several tenants in parallel, but each tenant's own imports
  // serialised behind a lock — see modules/imports/import.queue.ts.
  registerImportJobHandler();
}

/**
 * Queues the recurring work.
 *
 * `jobId` collapses duplicates, so a second worker starting does not create a
 * second repeating schedule — which is how a nightly scan quietly becomes a
 * twice-nightly one.
 */
export async function scheduleRecurringJobs(): Promise<void> {
  const queue = getJobQueue();

  await queue.add(QUEUE.outbox, { limit: 100 }, { everyMs: OUTBOX_DRAIN_MS, jobId: 'outbox-drain' });
  await queue.add(QUEUE.scheduled, { task: 'all' }, { everyMs: NIGHTLY_MS, jobId: 'nightly-scans' });

  logger.info({ driver: queue.driver }, 'Recurring jobs scheduled');
}
