import { QUEUE, getJobQueue } from '../../core/jobs/index.js';
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

const LOCK_TTL_MS = 30 * 60_000;

interface TenantLock {
  tenantId: string;
  importJobId: string;
  acquiredAt: Date;
}

const locks = new Map<string, TenantLock>();

function acquireLock(tenantId: string, importJobId: string): boolean {
  const held = locks.get(tenantId);

  // A stale lock — from a worker that died mid-run — must not block the tenant
  // forever. The TTL is generous enough that it cannot expire under a live run.
  if (held && Date.now() - held.acquiredAt.getTime() < LOCK_TTL_MS) {
    return held.importJobId === importJobId;
  }

  locks.set(tenantId, { tenantId, importJobId, acquiredAt: new Date() });
  return true;
}

function releaseLock(tenantId: string, importJobId: string): void {
  if (locks.get(tenantId)?.importJobId === importJobId) locks.delete(tenantId);
}

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
      if (!acquireLock(tenantId, importJobId)) {
        logger.info({ importJobId, tenantId }, 'Another import is running for this tenant; deferring');
        // Re-queued rather than failed: the user asked for this and it will run
        // as soon as the tenant's current import finishes.
        await getJobQueue().add(
          QUEUE.imports,
          { importJobId, tenantId },
          { jobId: `import:${importJobId}:retry:${Date.now()}`, delayMs: 10_000 },
        );
        return;
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
        releaseLock(tenantId, importJobId);
      }
    },
    // Several tenants at once; the lock keeps each tenant's own serial.
    3,
  );
}
