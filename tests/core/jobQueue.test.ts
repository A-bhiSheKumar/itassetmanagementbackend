import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initJobQueue, setJobQueue, QUEUE, type JobQueue } from '../../src/core/jobs/index.js';

/**
 * The job abstraction, exercised through the INLINE driver.
 *
 * Tests deliberately use inline: a job that runs on a shared Redis at an
 * unpredictable moment cannot be asserted on, and a test suite that needs
 * external infrastructure is a test suite people stop running.
 *
 * The BullMQ driver was verified against a real Redis — retries with backoff,
 * cross-restart deduplication by job id, and a fatal error rather than a silent
 * fallback in production. See backend/README.md.
 */
let queue: JobQueue;

beforeEach(async () => {
  setJobQueue(undefined);
  queue = await initJobQueue();
});

afterEach(async () => {
  await queue.close();
  setJobQueue(undefined);
});

describe('the job queue', () => {
  it('uses the deterministic driver under test', () => {
    expect(queue.driver).toBe('inline');
  });

  it('delivers a job to its registered handler', async () => {
    const seen: string[] = [];
    queue.register(QUEUE.scheduled, async ({ task }) => {
      seen.push(task);
    });
    await queue.start();

    await queue.add(QUEUE.scheduled, { task: 'metrics' });
    await queue.add(QUEUE.scheduled, { task: 'warranties' });

    expect(seen).toEqual(['metrics', 'warranties']);
  });

  it('drops a job with no handler rather than throwing', async () => {
    // The API produces jobs it does not consume — queuing one must never fail
    // a user's request just because this process has no worker for it.
    await queue.start();
    await expect(queue.add(QUEUE.imports, { importJobId: 'x', tenantId: 'y' })).resolves.toBeUndefined();
  });

  it('does not let a failing handler escape into the caller', async () => {
    queue.register(QUEUE.outbox, async () => {
      throw new Error('handler exploded');
    });
    await queue.start();

    // A background failure is logged and contained. Propagating it would fail
    // whatever happened to enqueue the job.
    await expect(queue.add(QUEUE.outbox, { limit: 1 })).resolves.toBeUndefined();
  });

  it('runs repeating jobs on their interval', async () => {
    let runs = 0;
    queue.register(QUEUE.outbox, async () => {
      runs += 1;
    });
    await queue.start();

    await queue.add(QUEUE.outbox, { limit: 1 }, { everyMs: 20 });
    await new Promise((r) => setTimeout(r, 90));

    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('stops repeating once closed', async () => {
    let runs = 0;
    queue.register(QUEUE.outbox, async () => {
      runs += 1;
    });
    await queue.start();
    await queue.add(QUEUE.outbox, { limit: 1 }, { everyMs: 20 });

    await new Promise((r) => setTimeout(r, 60));
    await queue.close();

    const atClose = runs;
    await new Promise((r) => setTimeout(r, 60));

    // A worker that keeps firing after shutdown holds the process open and
    // writes after the database connection has gone.
    expect(runs).toBe(atClose);
  });

  it('refuses to hand out a queue before it is initialised', async () => {
    const { getJobQueue } = await import('../../src/core/jobs/index.js');
    setJobQueue(undefined);

    expect(() => getJobQueue()).toThrow(/initJobQueue/);
  });
});
