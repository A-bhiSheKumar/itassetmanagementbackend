/**
 * Runs the API against a throwaway in-memory MongoDB replica set.
 *
 *   npm run dev:ephemeral
 *
 * For trying the app without Docker, and for smoke-testing a build. Data is
 * discarded on exit, so it is not a substitute for `npm run infra:up` — but it
 * removes the "install Docker first" step from a new contributor's day one.
 *
 * A REPLICA SET, not a standalone: transactions are load-bearing and a
 * standalone mongod rejects them at runtime.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});

process.env.MONGO_URI = replSet.getUri();
process.env.NODE_ENV ??= 'development';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'ephemeral-access-secret-at-least-32-characters';
process.env.JWT_REFRESH_SECRET ??= 'ephemeral-refresh-secret-at-least-32-characters';

process.stdout.write(`\nEphemeral MongoDB at ${replSet.getUri()}\nData is discarded on exit.\n\n`);

const shutdown = async (): Promise<void> => {
  await replSet.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await import('../src/main.js');
