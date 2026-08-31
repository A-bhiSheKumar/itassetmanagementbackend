import mongoose, { type ClientSession } from 'mongoose';
import { logger } from '../logging/index.js';
import { AppError, ErrorCode } from '../errors/index.js';

/**
 * A transaction that could not commit within our deadline.
 *
 * Surfaced as 503 rather than 500: it is a temporary condition — contention,
 * a slow primary, a stepdown — and the client should retry rather than treat
 * it as a permanent failure.
 */
export class TransactionTimeoutError extends AppError {
  constructor(deadlineMs: number) {
    super(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'That took too long to save. Please try again.',
      { details: { deadlineMs }, expected: false },
    );
  }
}

/**
 * Retries an upsert that lost a race to create the document.
 *
 * ── The race ───────────────────────────────────────────────────────────────
 * When several upserts target the same MISSING document at once, MongoDB lets
 * one insert and returns E11000 to the rest — documented behaviour, and the
 * documented remedy is to retry. On the retry the document exists, so the
 * operation becomes a plain update and cannot conflict again.
 *
 * This is not theoretical: the first burst of asset creations in a fresh tenant
 * all race to create the same tag counter, which is precisely what a bulk
 * import does on its first run. Without this, most of the batch fails with a
 * duplicate-key error about a document the user has never heard of.
 */
export async function upsertWithRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const isDuplicate = (err as { code?: number }).code === 11000;
      if (!isDuplicate || attempt >= attempts) throw err;

      // Brief jittered backoff so a large batch does not re-collide in lockstep.
      await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt));
    }
  }
}

/**
 * Transaction helper.
 *
 * Used wherever two writes must not diverge — assignment + cached pointer +
 * outbox event; asset + tag counter + usage counter (docs/03-data-model.md §4).
 *
 * ── THE CALLBACK MUST BE RE-RUNNABLE ─────────────────────────────────────
 * withTransaction RETRIES the callback on a transient conflict. Anything the
 * callback mutates must therefore be created or loaded INSIDE it.
 *
 * The trap, which cost real time to find: a Mongoose document built or fetched
 * outside and saved inside keeps its mutated in-memory state after a rollback —
 * `isNew` is false and `__v` has been bumped, but the row does not exist. The
 * retry issues an UPDATE matching that version, matches nothing, and throws
 * `VersionError: No matching document found`. Under concurrency this surfaced
 * as random 500s and hangs in completely unrelated tests.
 *
 *   ✗  const asset = await Asset.findById(id);
 *      await withTransaction((s) => asset.save({ session: s }));
 *
 *   ✓  await withTransaction(async (s) => {
 *        const asset = await Asset.findById(id).session(s);
 *        await asset.save({ session: s });
 *      });
 *
 * Three more rules:
 *   1. Keep transactions under a second. Never wrap an external HTTP call.
 *   2. Batch large work (import commits run ~500 rows per transaction) rather
 *      than wrapping a whole file — a 50,000-row transaction exceeds Mongo's
 *      size limit and holds locks far too long.
 *   3. Do nothing outside the database inside the callback. A retry would
 *      repeat it.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: { maxCommitTimeMS?: number; deadlineMs?: number } = {},
): Promise<T> {
  const session = await mongoose.startSession();
  const deadlineMs = options.deadlineMs ?? 10_000;

  try {
    let result: T;

    /**
     * ── No retry loop here, deliberately ──────────────────────────────────
     * session.withTransaction() ALREADY implements the driver-spec retry loop:
     * it re-runs the callback on TransientTransactionError and re-commits on
     * UnknownTransactionCommitResult, for up to 120 seconds.
     *
     * Wrapping it in a loop of our own multiplied that — three attempts of a
     * 120-second retry window is a six-minute worst case for one HTTP request.
     * It showed up as tests hanging past their timeout, which is the polite
     * version of what it would do in production.
     *
     * maxCommitTimeMS bounds the commit itself, so a request cannot sit waiting
     * on a majority acknowledgement that is never coming.
     */
    /**
     * Bounded by our own deadline.
     *
     * withTransaction's retry window is 120 seconds — far too long to hold an
     * HTTP request open. Racing it against a deadline turns an invisible hang
     * into a fast, actionable failure, and the abort releases the session so
     * the pinned connection returns to the pool.
     */
    const attempt = session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { maxCommitTimeMS: options.maxCommitTimeMS ?? 5_000 },
    );

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TransactionTimeoutError(deadlineMs)),
        deadlineMs,
      );
    });

    try {
      await Promise.race([attempt, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return result!;
  } catch (err) {
    logger.warn({ err }, 'Transaction failed');
    throw err;
  } finally {
    await session.endSession();
  }
}
