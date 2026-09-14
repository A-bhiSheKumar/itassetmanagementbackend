/**
 * The queue catalogue (docs/02-architecture.md §10).
 *
 * Names and payload shapes live here so a producer and a consumer cannot
 * disagree about what a job carries.
 */

export const QUEUE = {
  /** Delivers domain events a request could not flush inline. */
  outbox: 'outbox',
  /** Metric rollups, warranty notices, storage sweeps. */
  scheduled: 'scheduled',
  /** Import commits. Serialised per tenant by a lock, parallel across tenants. */
  imports: 'imports',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface JobPayloads {
  outbox: { limit?: number };
  scheduled: { task: 'metrics' | 'warranties' | 'storage-sweep' | 'reconcile' | 'all' };
  imports: { importJobId: string; tenantId: string };
}

export interface JobOptions {
  /** Retries before the job is dead-lettered. */
  attempts?: number;
  /** Exponential backoff base, in ms. */
  backoffMs?: number;
  /**
   * Collapses duplicates while one is outstanding. Two "commit import X" jobs
   * queued by a double click should be one job, not two. Recurring work is not
   * a repeating job any more — see `SCHEDULES` in src/jobs.ts.
   */
  jobId?: string;
  delayMs?: number;
}

export const DEFAULT_JOB_OPTIONS: Required<Pick<JobOptions, 'attempts' | 'backoffMs'>> = {
  attempts: 5,
  backoffMs: 1_000,
};
