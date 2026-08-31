import { beforeAll, afterAll, afterEach, inject } from 'vitest';
import mongoose from 'mongoose';
import { registerGlobalPlugins } from '../src/core/db/index.js';

/**
 * Per-file database wiring.
 *
 * The replica set itself starts once in globalSetup.ts — spinning one up per
 * test file costs ~2s each and buys nothing.
 */
beforeAll(async () => {
  // Plugins must be registered before any model compiles, or tenant scoping is
  // silently absent for that model. Idempotent, and this hook runs per file.
  registerGlobalPlugins();

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(inject('mongoUri'), {
      /**
       * Comfortably above the concurrency the suite exercises.
       *
       * A transaction PINS a connection for its duration, and the concurrency
       * tests deliberately fire ten simultaneous transactional writes. With the
       * old pool of 5, the surplus queued behind them and whichever request
       * happened to be next waited past its deadline — which surfaced as
       * unrelated tests timing out at random, later in longer runs.
       */
      maxPoolSize: 25,
      // Retryable operations ride out a brief primary stepdown instead of
      // failing the request that happened to be in flight.
      retryWrites: true,
      retryReads: true,
    });
  }
}, 60_000);

async function truncate(): Promise<void> {
  // Raw driver deletes, deliberately: going through the models would hit the
  // tenant-scope plugin and fail for want of a context.
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

let sharedFixtures = false;

/**
 * Opts a suite out of per-test truncation.
 *
 * The default — wipe between every test — is right for suites that assert on
 * counts. It is wasteful for read-only suites: the isolation suite was
 * re-registering two complete tenants (roles, subscription, catalogue, usage)
 * for each of its 38 tests, which dominated the run and pushed occasional tests
 * past the timeout.
 *
 * Safe because vitest runs test files sequentially in a single fork here, so
 * the flag cannot leak into another file. Only use it where the suite does not
 * mutate its own fixtures.
 */
export function useSharedFixtures(): void {
  beforeAll(() => {
    sharedFixtures = true;
  });

  afterAll(async () => {
    sharedFixtures = false;
    await truncate();
  });
}

afterEach(async () => {
  if (!sharedFixtures) await truncate();
});

afterAll(async () => {
  await mongoose.disconnect();
});
