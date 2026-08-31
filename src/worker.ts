import { logger } from './core/logging/index.js';
import { connectDatabase, disconnectDatabase } from './core/db/index.js';
import { dispatchPending } from './core/events/index.js';
import { initJobQueue, getJobQueue } from './core/jobs/index.js';
import { registerEventSubscribers } from './subscribers.js';
import { registerJobHandlers, scheduleRecurringJobs } from './jobs.js';

/**
 * Worker entrypoint (ADR-009).
 *
 * Same codebase, same modules, same services as the API — it runs job
 * consumers instead of an HTTP listener. Jobs execute inside a synthetic
 * request context (runAsSystem), so the tenant-scope plugin applies to them
 * exactly as it does to a request.
 *
 * Only the worker registers handlers. The API produces jobs but never consumes
 * them, which is what stops a scheduled scan running once per API replica.
 */
async function start(): Promise<void> {
  await connectDatabase();

  registerEventSubscribers();

  const queue = await initJobQueue();
  registerJobHandlers();
  await queue.start();
  await scheduleRecurringJobs();

  logger.info({ driver: queue.driver }, 'Worker started');

  installShutdownHandlers();
}

function installShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out after 20s — forcing exit');
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    try {
      // Closes workers first, so in-flight jobs finish rather than being lost
      // mid-transaction.
      await getJobQueue().close();

      // A final drain, so events committed moments ago are not left pending
      // until the next process starts.
      await dispatchPending(200).catch(() => undefined);

      await disconnectDatabase();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start worker');
  process.exit(1);
});
