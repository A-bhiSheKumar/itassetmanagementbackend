import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';

const server = useTestServer(createApp());

/**
 * Alerts that reference a metric nobody exports are worse than no alerts: they
 * look like coverage, and they stay silent through exactly the incident they
 * were written for. Prometheus reports this as an expression that evaluates to
 * nothing — never as an error — so it is invisible unless something checks.
 *
 * This is not hypothetical. The queue-depth alert was specified in the
 * readiness doc for weeks while `setGauge` had no call sites anywhere.
 */

const alerts = readFileSync('ops/prometheus/alerts.yml', 'utf8');

function metricNamesIn(text: string): string[] {
  return [...new Set(text.match(/itam_[a-z_]+/g) ?? [])];
}

describe('alert rules', () => {
  it('reference only metrics the app actually exports', async () => {
    // Prime the histogram and the counters, then scrape — the endpoint refreshes
    // the queue gauges itself.
    await request(server()).get('/api/v1/health/live');
    const scrape = await request(server()).get('/api/v1/health/metrics');

    const exported = scrape.text;
    const missing = metricNamesIn(alerts).filter((name) => !exported.includes(name));

    expect(missing).toEqual([]);
  });

  it('reference only event names that are exported from boot, at zero', async () => {
    const eventNames = [...alerts.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]!);
    expect(eventNames.length).toBeGreaterThan(0);

    const scrape = await request(server()).get('/api/v1/health/metrics');

    // Present and zero, not absent. An absent series and a quiet one look
    // identical to Prometheus, so an alert on an undeclared counter stays silent
    // until the first failure — the moment it was meant to fire.
    const undeclared = eventNames.filter(
      (name) => !scrape.text.includes(`itam_events_total{name="${name}"}`),
    );

    expect(undeclared).toEqual([]);
  });

  it('gives every paging alert a runbook to follow', () => {
    // Being woken at 03:00 by an alert with no runbook is how an on-call rota
    // stops being staffed.
    const blocks = alerts.split(/\n      - alert: /).slice(1);
    const paging = blocks.filter((b) => b.includes('severity: page'));

    expect(paging.length).toBeGreaterThan(0);
    expect(paging.filter((b) => !b.includes('runbook:')).map((b) => b.split('\n')[0])).toEqual([]);
  });
});
