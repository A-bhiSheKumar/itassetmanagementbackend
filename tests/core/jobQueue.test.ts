import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MongoQueue,
  JobModel,
  DeferJob,
  QUEUE,
  backoffDelay,
  claimSchedule,
  initJobQueue,
  getJobQueue,
  setJobQueue,
} from '../../src/core/jobs/index.js';
import { acquireLock, releaseLock } from '../../src/core/locks/index.js';

/**
 * The MongoDB job queue, against a real replica set.
 *
 * This is the queue production runs on Lambda, so its guarantees are asserted
 * on the real driver rather than a fake: a job runs once, a failure retries with
 * backoff and then dead-letters, a duplicate collapses, a lapsed lease is
 * recovered, and a deferral does not spend an attempt.
 *
 * `drain()` is driven directly — it is exactly what the Lambda jobs function
 * calls, so there is no polling timing to wait on.
 */

let queue: MongoQueue;

beforeEach(() => {
  queue = new MongoQueue(20);
});

afterEach(async () => {
  await queue.close();
});

const job = (queueName: string = QUEUE.scheduled) => JobModel.findOne({ queue: queueName }).lean();

describe('the job queue', () => {
  it('runs a queued job once, then marks it done', async () => {
    const seen: string[] = [];
    queue.register(QUEUE.scheduled, async ({ task }) => {
      seen.push(task);
    });

    await queue.add(QUEUE.scheduled, { task: 'metrics' });
    const result = await queue.drain();

    expect(seen).toEqual(['metrics']);
    expect(result.completed).toBe(1);

    const stored = await job();
    expect(stored?.status).toBe('done');
    // Out of the dedupe index, so the same work can be queued again later.
    expect(stored?.live).toBe(false);

    // A second drain finds nothing: it is not run twice.
    expect((await queue.drain()).completed).toBe(0);
  });

  it('collapses a duplicate while the first is still outstanding', async () => {
    queue.register(QUEUE.imports, async () => {});

    await queue.add(QUEUE.imports, { importJobId: 'a', tenantId: 't' }, { jobId: 'import:a' });
    await queue.add(QUEUE.imports, { importJobId: 'a', tenantId: 't' }, { jobId: 'import:a' });

    // Clicking Import twice queues one import.
    expect(await JobModel.countDocuments({ queue: QUEUE.imports })).toBe(1);
  });

  it('allows the same key again once the earlier job has finished', async () => {
    queue.register(QUEUE.outbox, async () => {});

    await queue.add(QUEUE.outbox, { limit: 1 }, { jobId: 'outbox-sweep' });
    await queue.drain();
    await queue.add(QUEUE.outbox, { limit: 1 }, { jobId: 'outbox-sweep' });

    expect(await JobModel.countDocuments({ queue: QUEUE.outbox })).toBe(2);
  });

  it('retries a failure later, with the error recorded', async () => {
    let calls = 0;
    queue.register(QUEUE.scheduled, async () => {
      calls += 1;
      throw new Error('database blip');
    });

    await queue.add(QUEUE.scheduled, { task: 'metrics' }, { attempts: 3, backoffMs: 60_000 });
    const result = await queue.drain();

    expect(calls).toBe(1);
    expect(result.failed).toBe(1);

    const stored = await job();
    expect(stored?.status).toBe('pending');
    expect(stored?.lastError).toBe('database blip');
    // Not immediately retryable: backoff pushed it into the future.
    expect(stored!.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it('dead-letters a job that has used all its attempts', async () => {
    queue.register(QUEUE.scheduled, async () => {
      throw new Error('permanent');
    });

    await queue.add(QUEUE.scheduled, { task: 'metrics' }, { attempts: 2, backoffMs: 1 });

    await queue.drain();
    // Make the retry due now rather than waiting out the backoff.
    await JobModel.updateOne({ queue: QUEUE.scheduled }, { $set: { runAt: new Date(0) } });
    await queue.drain();

    const stored = await job();
    expect(stored?.status).toBe('failed');
    expect(stored?.attempts).toBe(2);
    // Kept for a human, then it ages out.
    expect(stored?.expireAt).toBeInstanceOf(Date);

    const depth = await queue.stats();
    expect(depth.find((d) => d.queue === QUEUE.scheduled)?.failed).toBe(1);
  });

  it('recovers a job whose runner died holding the lease', async () => {
    const seen: string[] = [];
    queue.register(QUEUE.scheduled, async ({ task }) => {
      seen.push(task);
    });

    // A job claimed by a runner that no longer exists — a Lambda that timed out.
    await JobModel.create({
      queue: QUEUE.scheduled,
      payload: { task: 'warranties' },
      status: 'running',
      lockedBy: 'dead-runner',
      lockedUntil: new Date(Date.now() - 1_000),
      attempts: 1,
    });

    await queue.drain();

    expect(seen).toEqual(['warranties']);
    expect((await job())?.status).toBe('done');
  });

  it('leaves a job alone while another runner still holds a live lease', async () => {
    const seen: string[] = [];
    queue.register(QUEUE.scheduled, async ({ task }) => {
      seen.push(task);
    });

    await JobModel.create({
      queue: QUEUE.scheduled,
      payload: { task: 'metrics' },
      status: 'running',
      lockedBy: 'busy-runner',
      lockedUntil: new Date(Date.now() + 60_000),
      attempts: 1,
    });

    await queue.drain();
    expect(seen).toEqual([]);
  });

  it('defers without spending an attempt', async () => {
    queue.register(QUEUE.imports, async () => {
      throw new DeferJob(30_000, 'tenant lock held');
    });

    await queue.add(QUEUE.imports, { importJobId: 'x', tenantId: 't' }, { attempts: 3 });
    const result = await queue.drain();

    expect(result.deferred).toBe(1);
    const stored = await job(QUEUE.imports);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(0);
    expect(stored!.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('never runs one job twice when two runners drain at once', async () => {
    let runs = 0;
    const handler = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 30));
    };

    const other = new MongoQueue(20);
    queue.register(QUEUE.scheduled, handler, { concurrency: 3 });
    other.register(QUEUE.scheduled, handler, { concurrency: 3 });

    for (const task of ['metrics', 'warranties', 'reconcile', 'storage-sweep'] as const) {
      await queue.add(QUEUE.scheduled, { task });
    }

    // Two Lambdas, six concurrent claimers, four jobs.
    await Promise.all([queue.drain(), other.drain()]);

    expect(runs).toBe(4);
  });

  it('stops claiming new work once the time budget is spent', async () => {
    queue.register(QUEUE.scheduled, async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    for (let i = 0; i < 5; i += 1) await queue.add(QUEUE.scheduled, { task: 'metrics' });

    const result = await queue.drain({ budgetMs: 100 });

    // Started work finishes; the rest waits for the next invocation.
    expect(result.completed).toBeLessThan(5);
    expect(await JobModel.countDocuments({ status: 'pending' })).toBeGreaterThan(0);
  });

  it('polling loops pick up work, and stop when closed', async () => {
    const seen: string[] = [];
    queue.register(QUEUE.scheduled, async ({ task }) => {
      seen.push(task);
    });

    await queue.start();
    await queue.add(QUEUE.scheduled, { task: 'metrics' });

    const deadline = Date.now() + 2_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await queue.close();

    expect(seen).toEqual(['metrics']);
  });
});

describe('backoff', () => {
  it('grows exponentially and is capped at an hour', () => {
    expect(backoffDelay(1, 1_000)).toBeLessThanOrEqual(1_200);
    expect(backoffDelay(4, 1_000)).toBeGreaterThanOrEqual(6_400);
    expect(backoffDelay(30, 1_000)).toBeLessThanOrEqual(60 * 60_000 * 1.2);
  });
});

describe('schedules', () => {
  it('lets exactly one caller run a schedule per period', async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 6 }, () => claimSchedule('nightly', 60_000, now)));

    // EventBridge retried, two local processes ticked — still once.
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not run again until the interval has passed', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    expect(await claimSchedule('nightly', 60_000, start)).toBe(true);
    expect(await claimSchedule('nightly', 60_000, new Date(start.getTime() + 30_000))).toBe(false);
    expect(await claimSchedule('nightly', 60_000, new Date(start.getTime() + 61_000))).toBe(true);
  });
});

describe('locks', () => {
  it('is held by one holder at a time, and re-entrant for that holder', async () => {
    expect(await acquireLock('import-commit:t1', 60_000, 'import:a')).toBe('import:a');
    expect(await acquireLock('import-commit:t1', 60_000, 'import:b')).toBeNull();
    // A retried job re-enters its own lock rather than waiting on itself.
    expect(await acquireLock('import-commit:t1', 60_000, 'import:a')).toBe('import:a');

    await releaseLock('import-commit:t1', 'import:a');
    expect(await acquireLock('import-commit:t1', 60_000, 'import:b')).toBe('import:b');
  });

  it('lets a lapsed lock be taken over, so a dead holder cannot block a tenant', async () => {
    expect(await acquireLock('import-commit:t2', 1, 'import:dead')).toBe('import:dead');
    await new Promise((r) => setTimeout(r, 10));
    expect(await acquireLock('import-commit:t2', 60_000, 'import:next')).toBe('import:next');
  });

  it('never releases a lock someone else now holds', async () => {
    await acquireLock('import-commit:t3', 1, 'import:old');
    await new Promise((r) => setTimeout(r, 10));
    await acquireLock('import-commit:t3', 60_000, 'import:new');

    await releaseLock('import-commit:t3', 'import:old');
    expect(await acquireLock('import-commit:t3', 60_000, 'import:other')).toBeNull();
  });
});

describe('driver selection', () => {
  it('uses the inline driver under test, so request-queued jobs finish before the response', async () => {
    setJobQueue(undefined);
    expect((await initJobQueue()).driver).toBe('inline');
  });

  it('refuses to hand out a queue before it is initialised', () => {
    setJobQueue(undefined);
    expect(() => getJobQueue()).toThrow(/initJobQueue/);
  });
});
