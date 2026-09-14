import { hostname } from 'node:os';
import { ulid } from 'ulid';
import { isTest } from '../../config/index.js';
import { logger } from '../logging/index.js';
import { metrics } from '../telemetry/index.js';
import { JobModel } from './job.model.js';
import { QUEUE, DEFAULT_JOB_OPTIONS, type JobOptions, type JobPayloads, type QueueName } from './queues.js';

/**
 * Background work, behind one interface.
 *
 * ── Two drivers ──────────────────────────────────────────────────────────
 * MONGO everywhere real: jobs are rows in MongoDB, claimed atomically, retried
 * with backoff, deduplicated and dead-lettered. It works on AWS Lambda — where
 * nothing runs between invocations — because a job waits in the database until
 * a drain claims it, and a drain is just a function call.
 *
 * INLINE under test: a handler runs the moment its job is added, so a test can
 * assert on the result when the request returns rather than waiting on a poll.
 *
 * ── Replacing BullMQ ─────────────────────────────────────────────────────
 * BullMQ needed Redis and a worker process that never stops. The production
 * target has neither, so this driver replaces it. The interface did not change
 * shape for any producer: `add` still queues, `register` still consumes.
 *
 * ── How jobs get run ─────────────────────────────────────────────────────
 * `drain()` is the whole contract. On Lambda the jobs function calls it on a
 * schedule and after an enqueue kick. Locally, `start()` runs polling loops
 * that call the same claim-and-run step. There is no second implementation.
 */

export type JobHandler<N extends QueueName> = (payload: JobPayloads[N]) => Promise<void>;

export interface RegisterOptions {
  /** How many jobs of this queue one process runs at once. */
  concurrency?: number;
  /**
   * How long a claimed job is reserved before another runner may take it.
   * Must exceed the handler's worst-case run time, or a slow job gets run twice.
   */
  leaseMs?: number;
}

/**
 * A queue's backlog, for alerting.
 *
 * Depth is the signal that matters and no log line carries it: a queue is
 * healthy at depth 200 if it is draining and broken at depth 20 if it is not.
 * `failed` counts jobs that exhausted their retries and wait for a human.
 */
export interface QueueDepth {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface DrainResult {
  completed: number;
  failed: number;
  deferred: number;
}

export interface JobQueue {
  readonly driver: 'mongo' | 'inline';
  add<N extends QueueName>(queue: N, payload: JobPayloads[N], options?: JobOptions): Promise<void>;
  register<N extends QueueName>(queue: N, handler: JobHandler<N>, options?: RegisterOptions): void;
  /**
   * Runs due jobs until none are left or the time budget is spent.
   * The Lambda jobs function is essentially a call to this.
   */
  drain(options?: { queues?: QueueName[]; budgetMs?: number }): Promise<DrainResult>;
  /** Starts polling loops — a long-running local worker. Lambda never calls this. */
  start(): Promise<void>;
  close(): Promise<void>;
  stats(): Promise<QueueDepth[]>;
}

/**
 * Thrown by a handler that cannot run YET — not a failure.
 *
 * An import that finds its tenant's lock held should wait and try again, not
 * burn one of its three attempts. Deferring puts the job back with a delay and
 * leaves its attempt count untouched.
 */
export class DeferJob extends Error {
  constructor(
    readonly delayMs: number,
    reason: string,
  ) {
    super(reason);
    this.name = 'DeferJob';
  }
}

/** Retries double from the base, capped at an hour, with ±20% jitter. */
export function backoffDelay(attempt: number, baseMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 60 * 60_000);
  // Jitter stops a burst of jobs that failed together from retrying together
  // and failing together again — the thundering herd a flat backoff creates.
  const jitter = exponential * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

const DONE_RETENTION_MS = 7 * 86_400_000;
const FAILED_RETENTION_MS = 30 * 86_400_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Called after a job is queued, so work can start immediately.
 *
 * On Lambda this asynchronously invokes the jobs function — otherwise an import
 * the user just clicked would sit until the next minute's schedule. Locally the
 * polling loop picks it up within a second, so no kicker is set.
 */
type Kicker = (queue: QueueName) => void | Promise<void>;
let kicker: Kicker | null = null;

export function setJobKicker(next: Kicker | null): void {
  kicker = next;
}

// ── Mongo ───────────────────────────────────────────────────────────────────

interface Registration {
  handler: JobHandler<never>;
  concurrency: number;
  leaseMs: number;
}

export class MongoQueue implements JobQueue {
  readonly driver = 'mongo' as const;

  private readonly handlers = new Map<QueueName, Registration>();
  /** Identifies this runner on claimed jobs, so completion can check ownership. */
  private readonly runnerId = `${hostname()}:${process.pid}:${ulid()}`;
  private loops: Array<Promise<void>> = [];
  private stopping = false;

  constructor(private readonly pollIntervalMs = 1_000) {}

  async add<N extends QueueName>(queue: N, payload: JobPayloads[N], options: JobOptions = {}): Promise<void> {
    try {
      await JobModel.create({
        queue,
        payload,
        runAt: new Date(Date.now() + (options.delayMs ?? 0)),
        maxAttempts: options.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
        backoffMs: options.backoffMs ?? DEFAULT_JOB_OPTIONS.backoffMs,
        dedupeKey: options.jobId ?? null,
      });
    } catch (err) {
      // A live job with this key already exists: the duplicate IS the job.
      // Clicking "Import" twice queues one import.
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }

    // Best effort: a failed kick only delays the job until the next scheduled
    // drain, so it must never fail the request that queued it.
    try {
      await kicker?.(queue);
    } catch (err) {
      logger.warn({ err, queue }, 'Could not kick the job runner; the next scheduled drain will pick it up');
    }
  }

  register<N extends QueueName>(queue: N, handler: JobHandler<N>, options: RegisterOptions = {}): void {
    this.handlers.set(queue, {
      handler: handler as JobHandler<never>,
      concurrency: options.concurrency ?? 1,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    });
  }

  /**
   * Claims one due job from `queue`, or returns null.
   *
   * A single atomic update: the first runner to match a job owns it, and every
   * other concurrent runner simply matches nothing. Expired leases are matched
   * too, which is how a job abandoned by a dead runner is recovered.
   */
  private async claim(queue: QueueName, leaseMs: number) {
    const now = new Date();

    return JobModel.findOneAndUpdate(
      {
        queue,
        $or: [
          { status: 'pending', runAt: { $lte: now } },
          { status: 'running', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: 'running', lockedBy: this.runnerId, lockedUntil: new Date(now.getTime() + leaseMs) },
        $inc: { attempts: 1 },
      },
      { sort: { runAt: 1 }, new: true },
    ).exec();
  }

  /** Claims and runs one job. Returns what happened, or null if nothing was due. */
  private async runOne(queue: QueueName): Promise<keyof DrainResult | null> {
    const registration = this.handlers.get(queue);
    if (!registration) return null;

    const job = await this.claim(queue, registration.leaseMs);
    if (!job) return null;

    const owned = { _id: job._id, lockedBy: this.runnerId, status: 'running' as const };

    try {
      await (registration.handler as (p: unknown) => Promise<void>)(job.payload);

      await JobModel.updateOne(owned, {
        $set: {
          status: 'done',
          live: false,
          completedAt: new Date(),
          expireAt: new Date(Date.now() + DONE_RETENTION_MS),
          lockedBy: null,
          lockedUntil: null,
        },
      }).exec();

      metrics.increment('jobs_completed');
      return 'completed';
    } catch (err) {
      if (err instanceof DeferJob) {
        // Back to pending, and the attempt this claim counted is returned.
        await JobModel.updateOne(owned, {
          $set: { status: 'pending', runAt: new Date(Date.now() + err.delayMs), lockedBy: null, lockedUntil: null },
          $inc: { attempts: -1 },
        }).exec();
        logger.info({ queue, jobId: String(job._id), reason: err.message }, 'Job deferred');
        return 'deferred';
      }

      const exhausted = job.attempts >= job.maxAttempts;
      const message = (err as Error).message?.slice(0, 1_000) ?? String(err);

      await JobModel.updateOne(
        owned,
        exhausted
          ? {
              // Dead-lettered: kept for a month so a human can see why, and out
              // of the dedupe index so the same work can be queued again.
              $set: {
                status: 'failed',
                live: false,
                lastError: message,
                expireAt: new Date(Date.now() + FAILED_RETENTION_MS),
                lockedBy: null,
                lockedUntil: null,
              },
            }
          : {
              $set: {
                status: 'pending',
                lastError: message,
                runAt: new Date(Date.now() + backoffDelay(job.attempts, job.backoffMs)),
                lockedBy: null,
                lockedUntil: null,
              },
            },
      ).exec();

      metrics.increment(exhausted ? 'jobs_dead_lettered' : 'jobs_retried');
      logger[exhausted ? 'error' : 'warn'](
        { queue, jobId: String(job._id), attempt: job.attempts, err },
        exhausted ? 'Job dead-lettered' : 'Job failed, will retry',
      );
      return 'failed';
    }
  }

  async drain({ queues, budgetMs = 60_000 }: { queues?: QueueName[]; budgetMs?: number } = {}): Promise<DrainResult> {
    const deadline = Date.now() + budgetMs;
    const result: DrainResult = { completed: 0, failed: 0, deferred: 0 };
    const targets = (queues ?? [...this.handlers.keys()]).filter((q) => this.handlers.has(q));

    // Each queue drains with its own concurrency, in parallel with the others,
    // so a long import cannot starve the outbox sweep behind it.
    await Promise.all(
      targets.map(async (queue) => {
        const { concurrency } = this.handlers.get(queue)!;

        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            // A new job is only claimed while there is time to finish it. Work
            // already started always runs to completion.
            while (Date.now() < deadline) {
              const outcome = await this.runOne(queue);
              if (!outcome) break;
              result[outcome] += 1;
            }
          }),
        );
      }),
    );

    return result;
  }

  async start(): Promise<void> {
    this.stopping = false;

    for (const [queue, { concurrency }] of this.handlers) {
      for (let i = 0; i < concurrency; i += 1) {
        this.loops.push(this.poll(queue));
      }
    }

    logger.info({ queues: [...this.handlers.keys()], runner: this.runnerId }, 'Job runner polling');
  }

  private async poll(queue: QueueName): Promise<void> {
    while (!this.stopping) {
      let outcome: keyof DrainResult | null = null;

      try {
        outcome = await this.runOne(queue);
      } catch (err) {
        // A database blip must not kill the loop for the rest of the process.
        logger.error({ err, queue }, 'Job runner error; retrying after a pause');
      }

      // Straight on to the next job while there is work; otherwise wait,
      // jittered so many loops do not all wake and query in the same instant.
      if (!outcome && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs * (0.75 + Math.random() * 0.5)));
      }
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    // In-flight jobs finish; nothing new is claimed.
    await Promise.all(this.loops);
    this.loops = [];
  }

  async stats(): Promise<QueueDepth[]> {
    const now = new Date();
    const rows = await JobModel.aggregate<{ _id: { queue: string; bucket: string }; count: number }>([
      { $match: { status: { $in: ['pending', 'running', 'failed'] } } },
      {
        $group: {
          _id: {
            queue: '$queue',
            bucket: {
              $switch: {
                branches: [
                  { case: { $eq: ['$status', 'running'] }, then: 'active' },
                  { case: { $eq: ['$status', 'failed'] }, then: 'failed' },
                  { case: { $gt: ['$runAt', now] }, then: 'delayed' },
                ],
                default: 'waiting',
              },
            },
          },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    return (Object.values(QUEUE) as QueueName[]).map((queue) => {
      const count = (bucket: string) =>
        rows.find((r) => r._id.queue === queue && r._id.bucket === bucket)?.count ?? 0;
      return { queue, waiting: count('waiting'), active: count('active'), delayed: count('delayed'), failed: count('failed') };
    });
  }
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * Runs handlers in-process, immediately. Tests only.
 *
 * A job that runs "some time later" cannot be asserted on. Failures are logged
 * and contained, and a deferral is honoured once after its delay, which is
 * enough to exercise the import lock without a polling loop.
 */
class InlineQueue implements JobQueue {
  readonly driver = 'inline' as const;

  private readonly handlers = new Map<QueueName, JobHandler<never>>();

  async add<N extends QueueName>(name: N, payload: JobPayloads[N]): Promise<void> {
    await this.run(name, payload);
  }

  private async run(name: QueueName, payload: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) return;

    try {
      await (handler as (p: unknown) => Promise<void>)(payload);
    } catch (err) {
      if (err instanceof DeferJob) return;
      logger.error({ queue: name, err }, 'Inline job failed (no retry in this driver)');
    }
  }

  register<N extends QueueName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async drain(): Promise<DrainResult> {
    // Nothing is ever pending: every job ran when it was added.
    return { completed: 0, failed: 0, deferred: 0 };
  }

  async start(): Promise<void> {}

  async stats(): Promise<QueueDepth[]> {
    return (Object.values(QUEUE) as QueueName[]).map((queue) => ({
      queue,
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    }));
  }

  async close(): Promise<void> {}
}

// ── Selection ───────────────────────────────────────────────────────────────

let instance: JobQueue | undefined;

/**
 * Inline under test, Mongo everywhere else.
 *
 * No infrastructure probe, no fallback and no fatal path: the queue lives in
 * the same database the application already requires, so if the process has
 * started at all, the queue is available.
 */
export async function initJobQueue(): Promise<JobQueue> {
  instance ??= isTest ? new InlineQueue() : new MongoQueue();
  return instance;
}

export function getJobQueue(): JobQueue {
  if (!instance) throw new Error('initJobQueue() must run before jobs are queued.');
  return instance;
}

export function setJobQueue(next: JobQueue | undefined): void {
  instance = next;
}

export { QUEUE };
