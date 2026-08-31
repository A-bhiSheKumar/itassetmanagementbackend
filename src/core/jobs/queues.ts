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
  /** Staged import pipeline — M5. Concurrency 1 per tenant. */
  imports: 'imports',
  /** Async report and export builds — M5. */
  exports: 'exports',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface JobPayloads {
  outbox: { limit?: number };
  scheduled: { task: 'metrics' | 'warranties' | 'storage-sweep' | 'all' };
  imports: { importJobId: string; tenantId: string };
  exports: { exportJobId: string; tenantId: string };
}

export interface JobOptions {
  /** Retries before the job is dead-lettered. */
  attempts?: number;
  /** Exponential backoff base, in ms. */
  backoffMs?: number;
  /** Repeat forever on this interval. */
  everyMs?: number;
  /**
   * Collapses duplicates. Two "rebuild metrics for tenant X" jobs queued in the
   * same minute should be one job, not two.
   */
  jobId?: string;
  delayMs?: number;
}

export const DEFAULT_JOB_OPTIONS: Required<Pick<JobOptions, 'attempts' | 'backoffMs'>> = {
  attempts: 5,
  backoffMs: 1_000,
};
