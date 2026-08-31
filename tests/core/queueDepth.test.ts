import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { getJobQueue, QUEUE } from '../../src/core/jobs/index.js';

const server = useTestServer(createApp());

/**
 * Queue depth is the one operational signal no log line carries: a queue is
 * healthy at depth 200 if it is draining and broken at depth 20 if it is not.
 * Until this was exported there was nothing for a backlog alert to fire on.
 */

describe('queue depth', () => {
  it('reports every declared queue, not just the consumed ones', async () => {
    const stats = await getJobQueue().stats();

    // A backlog on a queue nobody is working is exactly the case worth
    // alerting on; reporting only consumed queues would hide it.
    expect(stats.map((s) => s.queue).sort()).toEqual(Object.values(QUEUE).sort());
  });

  it('is exposed to a scraper with a queue label', async () => {
    const res = await request(server()).get('/api/v1/health/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('# TYPE itam_queue_waiting gauge');
    expect(res.text).toMatch(/itam_queue_dead_lettered\{queue="[a-z-]+"\} \d+/);
  });

  it('serves the rest of the metrics even when queue depth cannot be read', async () => {
    const queue = getJobQueue();
    const original = queue.stats.bind(queue);
    queue.stats = () => Promise.reject(new Error('redis is gone'));

    try {
      const res = await request(server()).get('/api/v1/health/metrics');

      // Losing the queue gauges is a gap in a graph. A 500 here would blind the
      // scraper to error rate and latency too — which is how a monitoring
      // endpoint becomes the reason an outage goes unnoticed.
      expect(res.status).toBe(200);
      expect(res.text).toContain('itam_requests_total');
    } finally {
      queue.stats = original;
    }
  });
});
