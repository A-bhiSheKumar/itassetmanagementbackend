import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/index.js';
import { logger } from './core/logging/index.js';
import { registerEventSubscribers } from './subscribers.js';
import {
  connectDatabase,
  disconnectDatabase,
  assertTransactionsSupported,
} from './core/db/index.js';
import { seedPlans } from './modules/subscriptions/index.js';
import { initJobQueue } from './core/jobs/index.js';

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
   * The API PRODUCES jobs; it never consumes them.
   *
   * No handlers are registered and start() is not called here — otherwise every
   * API replica would also be a worker, and each scheduled scan would run once
   * per replica.
   */
  const queue = await initJobQueue();
  logger.info({ driver: queue.driver }, 'Job queue ready (producer only)');

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
