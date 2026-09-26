import type { Schema, Query, Aggregate } from 'mongoose';

/**
 * A ceiling on how long any single read may run.
 *
 * Without one, a query that turns into a collection scan — a missing index, an
 * unexpectedly large tenant — holds its request open until something else gives
 * up first: the load balancer, the browser, or on Lambda the whole 15-minute
 * invocation. The database is the right place to stop it, because it is the one
 * that can actually abandon the work.
 *
 * Ten seconds is far beyond any query this product makes on purpose (the
 * dashboard's heaviest is single-digit milliseconds at 100k assets), so hitting
 * it means something is wrong — and the error handler turns it into a 503 that
 * says "try again", not a request that hangs.
 */
const READ_TIMEOUT_MS = 10_000;

export function queryTimeoutPlugin(schema: Schema): void {
  schema.pre(/^(find|count|distinct)/, function (this: Query<unknown, unknown>) {
    // Never overrides an explicit choice: a deliberate long-running maintenance
    // query can raise its own ceiling.
    if (this.getOptions().maxTimeMS === undefined) this.setOptions({ maxTimeMS: READ_TIMEOUT_MS });
  });

  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const options = this.options as { maxTimeMS?: number };
    if (options.maxTimeMS === undefined) this.options.maxTimeMS = READ_TIMEOUT_MS;
  });
}
