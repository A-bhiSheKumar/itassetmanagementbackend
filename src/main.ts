import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env, isDevelopment } from './config/index.js';
import { logger } from './core/logging/index.js';
import { registerEventSubscribers } from './subscribers.js';
import {
  connectDatabase,
  disconnectDatabase,
  assertTransactionsSupported,
} from './core/db/index.js';
import { seedPlans } from './modules/subscriptions/index.js';
import { initJobQueue } from './core/jobs/index.js';
import { registerJobHandlers, startLocalScheduler } from './jobs.js';
import { warnIfUnconfigured } from './core/telemetry/index.js';
import { setRateLimitStore, MongoRateLimitStore } from './core/http/index.js';

/**
 * API entrypoint.
 *
 * The worker (worker.ts) is the same codebase with a different entrypoint, so
 * a background job and an HTTP request run identical business logic. There is
 * no second implementation to drift.
 */
async function start(): Promise<void> {
  await connectDatabase();

  // Audit, timeline and (later) webhooks all hang off the outbox.
  registerEventSubscribers();
  await assertTransactionsSupported();

  // Plans are reference data the signup flow depends on. Idempotent.
  await seedPlans();

  /**
   * Where jobs run.
   *
   * In development this process runs them too, so `npm run dev` is the whole
   * app — an import queued from the browser actually commits. In production
   * the API only ever PRODUCES: on Lambda the jobs function drains the queue,
   * and a long-running API that also consumed would run each job wherever it
   * happened to land.
   *
   * Running `npm run dev:worker` alongside is harmless: jobs are claimed
   * atomically, so two runners never take the same one.
   */
  const queue = await initJobQueue();

  if (isDevelopment) {
    registerJobHandlers();
    await queue.start();
    startLocalScheduler();
    logger.info('Development: this process also runs background jobs.');
  }

  // Counts that hold across processes, for the limits that must be exact.
  setRateLimitStore('shared', new MongoRateLimitStore());
  warnIfUnconfigured();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  installShutdownHandlers(server);
}

/**
 * Graceful shutdown. Without this, a deploy drops every request in flight —
 * including a half-committed import batch.
 */
function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out after 15s — forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    server.close(() => logger.info('HTTP server closed'));

    try {
      await disconnectDatabase();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
