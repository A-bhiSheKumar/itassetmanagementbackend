import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from '../../src/core/telemetry/index.js';

/**
 * The exposition format is picky, and a malformed line is not a soft failure:
 * Prometheus rejects the whole scrape, so one bad metric loses every metric.
 */

beforeEach(() => metrics.reset());

describe('labelled gauges', () => {
  it('emits one TYPE line per name, however many label sets', () => {
    metrics.setGauge('queue_waiting', 3, { queue: 'scheduled' });
    metrics.setGauge('queue_waiting', 7, { queue: 'notifications' });

    const text = metrics.render();

    // A repeated TYPE line for the same metric makes Prometheus reject the scrape.
    expect(text.match(/# TYPE itam_queue_waiting gauge/g)).toHaveLength(1);
    expect(text).toContain('itam_queue_waiting{queue="scheduled"} 3');
    expect(text).toContain('itam_queue_waiting{queue="notifications"} 7');
  });

  it('overwrites a label set rather than accumulating duplicates', () => {
    metrics.setGauge('queue_waiting', 3, { queue: 'scheduled' });
    metrics.setGauge('queue_waiting', 0, { queue: 'scheduled' });

    const lines = metrics.render().split('\n').filter((l) => l.startsWith('itam_queue_waiting'));

    // Two lines with the same labels is a duplicate sample — also a rejected scrape.
    expect(lines).toEqual(['itam_queue_waiting{queue="scheduled"} 0']);
  });

  it('renders an unlabelled gauge without empty braces', () => {
    metrics.setGauge('pool_size', 10);
    expect(metrics.render()).toContain('\nitam_pool_size 10');
  });

  it('escapes a label value that would otherwise break the line', () => {
    metrics.setGauge('queue_waiting', 1, { queue: 'we"ird' });
    expect(metrics.render()).toContain('itam_queue_waiting{queue="we\\"ird"} 1');
  });
});
