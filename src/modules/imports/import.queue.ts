import { QUEUE, getJobQueue, DeferJob } from '../../core/jobs/index.js';
import { acquireLock, releaseLock } from '../../core/locks/index.js';
import { runAsSystem } from '../../core/context/index.js';
import { logger } from '../../core/logging/index.js';
import { ImportJobModel } from './importJob.model.js';
import { commitImport } from './import.service.js';

/**
 * Running an import commit as a background job.
 *
 * ── Why not inline ────────────────────────────────────────────────────────
 * A 5,000-row commit is minutes of work. Holding an HTTP request open for it
 * means a browser timeout, a load-balancer timeout, or a user who closes the
 * tab and loses the run. The client polls the job instead.
 *
 * ── One import at a time per tenant ───────────────────────────────────────
 * Two concurrent imports of overlapping data both see "no existing record" in
 * their dry run and both create it — the classic duplicate-creation bug
 * (docs/06-edge-cases.md #36). Different tenants still run in parallel; only a
 * single customer's imports are serialised.
 *
 * Implemented as a lock document rather than a queue-level concurrency of 1,
 * which would serialise every tenant behind whichever one uploaded first.
 */

/**
 * Longer than any commit can run on Lambda (15 minutes), so a live run always
 * finishes inside its lock; a dead one frees the tenant within the TTL.
 */
const LOCK_TTL_MS = 16 * 60_000;

/** How long an import waits before checking the tenant's lock again. */
const LOCK_RETRY_MS = 15_000;

/**
 * The lock is a MongoDB document, not a `Map`.
 *
 * It used to live in process memory, which never serialised imports across two
 * workers and, on Lambda, would serialise nothing at all: every concurrent
 * invocation is its own container with its own empty `Map`. That would reopen
 * exactly the duplicate-creation race the lock exists to close.
 */
const lockKey = (tenantId: string) => `import-commit:${tenantId}`;

export async function queueImportCommit(importJobId: string, tenantId: string): Promise<void> {
  await getJobQueue().add(
    QUEUE.imports,
    { importJobId, tenantId },
    {
      // Deduplicated by job: clicking "Import" twice must not run it twice.
      jobId: `import:${importJobId}`,
      // Retried at the JOB level, but the commit itself is idempotent per row,
      // so a retry resumes rather than duplicating.
      attempts: 3,
      backoffMs: 5_000,
    },
  );
}

export function registerImportJobHandler(): void {
  getJobQueue().register(
    QUEUE.imports,
    async ({ importJobId, tenantId }) => {
      // The holder is the import itself, so a retried job re-enters its own
      // lock instead of waiting on itself.
      const holder = await acquireLock(lockKey(tenantId), LOCK_TTL_MS, `import:${importJobId}`);

      if (!holder) {
        // Deferred, not failed: the user asked for this, and it runs as soon as
        // the tenant's current import finishes — without spending an attempt.
        throw new DeferJob(LOCK_RETRY_MS, 'Another import is running for this tenant');
      }

      try {
        // Jobs run under a synthetic tenant context, so the tenant-scope plugin
        // applies to them exactly as it does to a request.
        await runAsSystem({ requestId: `import-${importJobId}`, tenantId, actorType: 'import' }, () =>
          commitImport(importJobId),
        );
      } catch (err) {
        logger.error({ err, importJobId, tenantId }, 'Import commit failed');

        await runAsSystem({ requestId: `import-${importJobId}`, tenantId }, async () => {
          // Recorded on the job so the user sees why, rather than a run that
          // simply stops progressing.
          await ImportJobModel.updateOne(
            { _id: importJobId },
            { $set: { status: 'failed', error: (err as Error).message.slice(0, 500) } },
          );
        });

        throw err;
      } finally {
        await releaseLock(lockKey(tenantId), holder);
      }
    },
    {
      // Several tenants at once; the lock keeps each tenant's own serial.
      concurrency: 3,
      // Must outlast the longest commit, or a slow import is claimed twice.
      leaseMs: LOCK_TTL_MS,
    },
  );
}
