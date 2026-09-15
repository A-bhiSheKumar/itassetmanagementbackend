import { QUEUE, getJobQueue, claimSchedule } from './core/jobs/index.js';
import { dispatchPending } from './core/events/index.js';
import { logger } from './core/logging/index.js';
import {
  rebuildAllMetrics,
  scanExpiringWarranties,
  scanLicenceRenewals,
  sweepStorage,
  reconcileAll,
  purgeRecycleBins,
} from './modules/reports/index.js';
import { registerImportJobHandler } from './modules/imports/index.js';
import { deliverEmail } from './modules/email/index.js';
import { sendPasswordReset } from './modules/identity/index.js';

/**
 * The composition root for background work.
 *
 * Lives here rather than in core/jobs because core is framework and must not
 * import a module — the same rule that puts event subscribers in subscribers.ts.
 */

export function registerJobHandlers(): void {
  const queue = getJobQueue();

  /**
   * Retries anything an HTTP request could not deliver inline — a subscriber
   * that failed, or a process that died between commit and flush. Happy-path
   * delivery already happens inside the request, so this is a sweeper.
   */
  queue.register(
    QUEUE.outbox,
    async ({ limit }) => {
      const delivered = await dispatchPending(limit ?? 100);
      if (delivered > 0) logger.debug({ delivered }, 'Outbox drained');
    },
    // Single consumer: concurrent drains would fight over the same rows.
    { concurrency: 1 },
  );

  queue.register(
    QUEUE.scheduled,
    async ({ task }) => {
      // Before the rollup: it counts assigned assets, and reconciling afterwards
      // would leave the dashboard reporting yesterday's drift for a day.
      if (task === 'reconcile' || task === 'all') await reconcileAll({ repair: true });
      if (task === 'metrics' || task === 'all') await rebuildAllMetrics();
      if (task === 'warranties' || task === 'all') await scanExpiringWarranties();
      if (task === 'renewals' || task === 'all') await scanLicenceRenewals();
      if (task === 'storage-sweep' || task === 'all') await sweepStorage();
      // Not part of 'all': it has its own hourly schedule.
      if (task === 'recycle-bin-purge') await purgeRecycleBins();
    },
    // A cross-tenant sweep can take a while on a large estate. The lease stays
    // under Lambda's 15-minute ceiling with room to finish cleanly.
    { concurrency: 1, leaseMs: 14 * 60_000 },
  );

  registerImportJobHandler();

  // Several at once: each is one HTTP call to Resend, and a backlog of
  // invitations should clear in seconds rather than one by one.
  queue.register(QUEUE.email, ({ messageId }) => deliverEmail(messageId), { concurrency: 5, leaseMs: 60_000 });

  queue.register(QUEUE.account, async ({ task, email }) => {
    if (task === 'password-reset') await sendPasswordReset(email);
  });
}

/**
 * Recurring work, as data.
 *
 * Not repeating jobs: a schedule that lives in the queue is a schedule that
 * duplicates the moment a second runner registers it. Instead each entry is
 * claimed per period in the database (`claimSchedule`), so it runs once no
 * matter how many runners tick — EventBridge every minute in production, the
 * local worker every thirty seconds.
 */
export const SCHEDULES = [
  {
    name: 'outbox-sweep',
    // EventBridge's floor is one minute. The sweep is only a retry path, so a
    // minute of latency on a failed delivery is the right trade.
    intervalMs: 60_000,
    enqueue: () => getJobQueue().add(QUEUE.outbox, { limit: 200 }, { jobId: 'outbox-sweep' }),
  },
  {
    name: 'nightly-scans',
    /**
     * Daily. The constant this replaced was called NIGHTLY_MS and was set to
     * one hour, so "nightly" scans ran twenty-four times a day. Harmless only
     * because each is idempotent; wasteful on a large estate, and misleading to
     * anyone reading the runbook. The dashboard has a manual rebuild for anyone
     * who needs fresher figures.
     */
    intervalMs: 24 * 60 * 60_000,
    enqueue: () => getJobQueue().add(QUEUE.scheduled, { task: 'all' }, { jobId: 'nightly-scans' }),
  },
  {
    name: 'recycle-bin-purge',
    intervalMs: 60 * 60_000,
    enqueue: () => getJobQueue().add(QUEUE.scheduled, { task: 'recycle-bin-purge' }, { jobId: 'recycle-bin-purge' }),
  },
] as const;

/**
 * Queues every schedule that is due. Safe to call from any number of places.
 * Returns the names that this caller won.
 */
export async function runDueSchedules(now = new Date()): Promise<string[]> {
  const started: string[] = [];

  for (const schedule of SCHEDULES) {
    try {
      if (await claimSchedule(schedule.name, schedule.intervalMs, now)) {
        await schedule.enqueue();
        started.push(schedule.name);
      }
    } catch (err) {
      // One broken schedule must not stop the others from being considered.
      logger.error({ err, schedule: schedule.name }, 'Could not start a scheduled job');
    }
  }

  // The minute-by-minute outbox sweep is routine; only the rarer work is worth
  // an info line, or the log becomes a heartbeat nobody reads.
  const notable = started.filter((name) => name !== 'outbox-sweep');
  if (notable.length > 0) logger.info({ started: notable }, 'Scheduled work queued');
  else if (started.length > 0) logger.debug({ started }, 'Scheduled work queued');
  return started;
}

/**
 * Ticks `runDueSchedules` on an interval, for a long-running local process.
 *
 * Production has no equivalent in code: EventBridge is the clock there. The
 * claim in the database makes it safe for this and EventBridge — or two local
 * processes — to tick at once.
 */
export function startLocalScheduler(intervalMs = 30_000): () => void {
  const tick = () => void runDueSchedules().catch((err) => logger.error({ err }, 'Scheduler tick failed'));

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
