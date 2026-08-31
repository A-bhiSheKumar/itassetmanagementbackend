import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { env, isProduction, isTest } from '../../config/index.js';
import { logger } from '../logging/index.js';
import { metrics } from '../telemetry/index.js';
import { QUEUE, DEFAULT_JOB_OPTIONS, type JobOptions, type JobPayloads, type QueueName } from './queues.js';

/**
 * Background work, behind one interface.
 *
 * ── Why an abstraction rather than BullMQ directly ────────────────────────
 * Two reasons, both practical. A developer should be able to run the app
 * without Redis — the same reason `npm run dev:ephemeral` exists — and the
 * tests need job handlers to run deterministically rather than on another
 * machine's schedule.
 *
 * So there are two drivers. BullMQ when Redis is reachable: durable, retried,
 * shared across replicas, with repeatable jobs. Inline when it is not: handlers
 * run in-process, immediately.
 *
 * The fallback is NEVER silent in production. Running jobs in-process on every
 * API replica would mean every scheduled scan firing N times and no durability
 * at all, so a missing Redis in production is fatal rather than degraded.
 */

export type JobHandler<N extends QueueName> = (payload: JobPayloads[N]) => Promise<void>;

/**
 * A queue's backlog, for alerting.
 *
 * Depth is the signal that matters and no log line carries it: a queue is
 * healthy at depth 200 if it is draining and broken at depth 20 if it is not.
 * `failed` counts jobs that exhausted their retries and are sitting in the
 * dead-letter set waiting for a human.
 */
export interface QueueDepth {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface JobQueue {
  readonly driver: 'bullmq' | 'inline';
  add<N extends QueueName>(queue: N, payload: JobPayloads[N], options?: JobOptions): Promise<void>;
  register<N extends QueueName>(queue: N, handler: JobHandler<N>, concurrency?: number): void;
  /** Starts consuming. Producers do not need this; the worker does. */
  start(): Promise<void>;
  close(): Promise<void>;
  /** Current backlog per queue. Read at scrape time, so it is never stale. */
  stats(): Promise<QueueDepth[]>;
}

// ── BullMQ ──────────────────────────────────────────────────────────────────

class BullMqQueue implements JobQueue {
  readonly driver = 'bullmq' as const;

  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly handlers = new Map<QueueName, { handler: JobHandler<never>; concurrency: number }>();

  constructor(url: string) {
    const parsed = new URL(url);
    this.connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      ...(parsed.password ? { password: parsed.password } : {}),
      // BullMQ requires this; without it a blocking command can be retried
      // forever and a worker silently stops consuming.
      maxRetriesPerRequest: null,
    };
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async add<N extends QueueName>(
    name: N,
    payload: JobPayloads[N],
    options: JobOptions = {},
  ): Promise<void> {
    await this.queue(name).add(name, payload, {
      attempts: options.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
      backoff: { type: 'exponential', delay: options.backoffMs ?? DEFAULT_JOB_OPTIONS.backoffMs },
      // Deduplication: a job id that already exists is not queued twice.
      // BullMQ rejects ':' outright — it is their Redis key separator — so
      // callers may use it freely and it is normalised here.
      ...(options.jobId ? { jobId: options.jobId.replace(/:/g, '-') } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      ...(options.everyMs ? { repeat: { every: options.everyMs } } : {}),
      // Keep a short tail for debugging; the rest is noise that fills Redis.
      removeOnComplete: { age: 3_600, count: 500 },
      removeOnFail: { age: 24 * 3_600 },
    });
  }

  register<N extends QueueName>(name: N, handler: JobHandler<N>, concurrency = 5): void {
    this.handlers.set(name, { handler: handler as JobHandler<never>, concurrency });
  }

  async start(): Promise<void> {
    for (const [name, { handler, concurrency }] of this.handlers) {
      const worker = new Worker(
        name,
        async (job: Job) => {
          await (handler as (p: unknown) => Promise<void>)(job.data);
        },
        { connection: this.connection, concurrency },
      );

      worker.on('completed', () => metrics.increment('jobs_completed'));

      worker.on('failed', (job, err) => {
        const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
        // A dead-lettered job needs a human. Retries in between are expected,
        // and counting them separately keeps a retry storm distinguishable from
        // a queue that is actually losing work.
        metrics.increment(exhausted ? 'jobs_dead_lettered' : 'jobs_retried');

        logger[exhausted ? 'error' : 'warn'](
          { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err },
          exhausted ? 'Job dead-lettered' : 'Job failed, will retry',
        );
      });

      this.workers.push(worker);
    }

    logger.info({ queues: [...this.handlers.keys()] }, 'BullMQ workers started');
  }

  async stats(): Promise<QueueDepth[]> {
    // Every declared queue, not just the ones this replica consumes — a backlog
    // on a queue nobody is working is exactly the case worth alerting on, and
    // reporting only consumed queues would hide it.
    const names = Object.values(QUEUE) as QueueName[];

    return Promise.all(
      names.map(async (queue) => {
        const counts = await this.queue(queue).getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );

        return {
          queue,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }

  async close(): Promise<void> {
    // Workers first: they must finish in-flight jobs before the connections go.
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * Runs handlers in-process, immediately.
 *
 * For development without Redis and for tests, where a job that runs "some time
 * later on another machine" is untestable. Repeating jobs become intervals.
 */
class InlineQueue implements JobQueue {
  readonly driver = 'inline' as const;

  private readonly handlers = new Map<QueueName, JobHandler<never>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly repeats: Array<{ name: QueueName; payload: unknown; everyMs: number }> = [];
  private started = false;

  async add<N extends QueueName>(
    name: N,
    payload: JobPayloads[N],
    options: JobOptions = {},
  ): Promise<void> {
    if (options.everyMs) {
      this.repeats.push({ name, payload, everyMs: options.everyMs });
      if (this.started) this.schedule(name, payload, options.everyMs);
      return;
    }

    await this.run(name, payload);
  }

  private async run(name: QueueName, payload: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) return;

    try {
      await (handler as (p: unknown) => Promise<void>)(payload);
    } catch (err) {
      // No retry machinery here — that is precisely what BullMQ is for. Losing
      // a job is acceptable in development; it is why this driver is refused in
      // production.
      logger.error({ queue: name, err }, 'Inline job failed (no retry in this driver)');
    }
  }

  private schedule(name: QueueName, payload: unknown, everyMs: number): void {
    const timer = setInterval(() => void this.run(name, payload), everyMs);
    timer.unref();
    this.timers.push(timer);
  }

  register<N extends QueueName>(name: N, handler: JobHandler<N>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async start(): Promise<void> {
    this.started = true;
    for (const repeat of this.repeats) this.schedule(repeat.name, repeat.payload, repeat.everyMs);
    logger.warn(
      { queues: [...this.handlers.keys()] },
      'Running jobs IN-PROCESS — no durability, no retries. Development only.',
    );
  }

  /**
   * Always zero, honestly.
   *
   * This driver runs handlers synchronously, so there is never a backlog to
   * report — the depth is genuinely zero rather than unknown.
   */
  async stats(): Promise<QueueDepth[]> {
    return (Object.values(QUEUE) as QueueName[]).map((queue) => ({
      queue,
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    }));
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

let instance: JobQueue | undefined;

async function redisReachable(url: string): Promise<boolean> {
  const { default: IORedis } = await import('ioredis');
  const client = new IORedis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  // A failed connection is the question being asked, not an incident. Without a
  // listener ioredis prints "Unhandled error event" and, on some Node versions,
  // takes the process down for something we are deliberately testing.
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

export async function initJobQueue(): Promise<JobQueue> {
  if (instance) return instance;

  // Tests must be deterministic: a job that runs on a shared Redis at an
  // unpredictable moment cannot be asserted on.
  if (isTest) {
    instance = new InlineQueue();
    return instance;
  }

  if (await redisReachable(env.REDIS_URL)) {
    instance = new BullMqQueue(env.REDIS_URL);
    return instance;
  }

  if (isProduction) {
    // Fatal, not degraded. In-process jobs across N API replicas means every
    // scheduled scan fires N times and nothing survives a restart.
    throw new Error(
      `Redis is unreachable at ${env.REDIS_URL}. Background jobs cannot run without it.`,
    );
  }

  logger.warn({ url: env.REDIS_URL }, 'Redis unreachable — falling back to in-process jobs');
  instance = new InlineQueue();
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
