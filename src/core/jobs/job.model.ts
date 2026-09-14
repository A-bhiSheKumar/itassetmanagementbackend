import { Schema, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../db/index.js';

/**
 * The job queue, as a MongoDB collection.
 *
 * ── Why a collection and not Redis ───────────────────────────────────────
 * The platform runs on AWS Lambda with MongoDB Atlas and no Redis. BullMQ needs
 * both Redis and an always-on worker process; Lambda provides neither. A table
 * of jobs claimed with an atomic `findOneAndUpdate` gives the same guarantees
 * that mattered — durable, retried with backoff, deduplicated, dead-lettered —
 * on infrastructure that already exists, and it is the pattern the LMS already
 * runs in production for email retries.
 *
 * ── Leases, not locks ───────────────────────────────────────────────────
 * Claiming a job sets `lockedUntil`. A runner that dies (a Lambda timing out, a
 * laptop closing) simply stops renewing, the lease lapses, and the next drain
 * reclaims the job. Completing checks `lockedBy`, so a runner whose lease was
 * taken over cannot overwrite the result of the runner that took it.
 *
 * Global, not tenant-scoped: a runner claims jobs before any tenant context
 * exists. Jobs that act on one tenant carry `tenantId` in their payload and
 * re-enter that tenant with `runAsSystem`, so the tenant-scope plugin still
 * applies to everything the handler does.
 */

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const jobSchema = markSchemaGlobal(
  new Schema(
    {
      queue: { type: String, required: true },
      payload: { type: Schema.Types.Mixed, default: {} },

      status: { type: String, enum: JOB_STATUSES, default: 'pending' },
      /** Eligible to run from this moment — a delay, or the next retry. */
      runAt: { type: Date, required: true, default: () => new Date() },

      attempts: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 5 },
      backoffMs: { type: Number, default: 1_000 },

      lockedUntil: { type: Date, default: null },
      lockedBy: { type: String, default: null },

      /**
       * Collapses duplicates while a job is outstanding.
       *
       * Enforced through `live` rather than a partial filter on `status`,
       * because partial indexes cannot use `$in` — and an index with an
       * unsupported filter is created without error and simply never exists,
       * which is how four indexes on this project were once found to be
       * missing.
       */
      dedupeKey: { type: String, default: null },
      live: { type: Boolean, default: true },

      lastError: { type: String, default: null },
      completedAt: { type: Date, default: null },
      /** Set on completion, so finished jobs age out on their own. */
      expireAt: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);

// The claim query: due pending jobs, and running jobs whose lease has lapsed.
jobSchema.index({ queue: 1, status: 1, runAt: 1 });
jobSchema.index({ queue: 1, status: 1, lockedUntil: 1 });

jobSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { live: true, dedupeKey: { $type: 'string' } } },
);

// Done jobs are kept a week for debugging, dead ones a month for a human.
jobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export interface Job {
  queue: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  lockedUntil: Date | null;
  lockedBy: string | null;
  dedupeKey: string | null;
  live: boolean;
  lastError: string | null;
  completedAt: Date | null;
  expireAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobDocument = HydratedDocument<Job>;

export const JobModel = defineModel('Job', jobSchema) as unknown as Model<Job>;
