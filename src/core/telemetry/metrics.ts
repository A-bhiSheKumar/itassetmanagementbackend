/**
 * In-process metrics, exposed in Prometheus text format.
 *
 * Deliberately hand-rolled rather than pulling in a client library: what is
 * needed is four counters and one histogram, and the exposition format is a
 * dozen lines. A dependency would be more code than this, not less.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 * Alerting, not debugging. The three things worth waking someone for are error
 * RATE, latency, and queue depth — none of which a log line tells you, because
 * a log line is one event and these are all shapes over time.
 *
 * Per-replica, like any process-level metrics. A scraper aggregates across
 * replicas; that is its job, not ours.
 */

/** Request durations bucket into these, in milliseconds. */
const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

interface RouteStats {
  count: number;
  errors: number;
  totalMs: number;
  buckets: number[];
}

class Metrics {
  private readonly routes = new Map<string, RouteStats>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly startedAt = Date.now();

  /**
   * Records a completed request.
   *
   * Keyed by the route PATTERN, not the URL — `/assets/:id`, never
   * `/assets/6a94...`. A per-id series is unbounded cardinality, which is the
   * standard way to take down a metrics backend.
   */
  observeRequest(method: string, routePattern: string, statusCode: number, durationMs: number): void {
    const key = `${method} ${routePattern}`;

    let stats = this.routes.get(key);
    if (!stats) {
      stats = { count: 0, errors: 0, totalMs: 0, buckets: new Array(LATENCY_BUCKETS.length + 1).fill(0) };
      this.routes.set(key, stats);
    }

    stats.count += 1;
    stats.totalMs += durationMs;
    // Only 5xx counts as an error. A 404 or a 403 is the system working.
    if (statusCode >= 500) stats.errors += 1;

    const bucket = LATENCY_BUCKETS.findIndex((limit) => durationMs <= limit);
    stats.buckets[bucket === -1 ? LATENCY_BUCKETS.length : bucket]! += 1;
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** For values that go down as well as up — queue depth, pool size. */
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  reset(): void {
    this.routes.clear();
    this.counters.clear();
    this.gauges.clear();
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    lines.push('# HELP itam_uptime_seconds Seconds since this process started.');
    lines.push('# TYPE itam_uptime_seconds gauge');
    lines.push(`itam_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);

    lines.push('# HELP itam_requests_total Completed HTTP requests.');
    lines.push('# TYPE itam_requests_total counter');
    for (const [key, stats] of this.routes) {
      lines.push(`itam_requests_total{route="${escape(key)}"} ${stats.count}`);
    }

    lines.push('# HELP itam_request_errors_total Requests that returned 5xx.');
    lines.push('# TYPE itam_request_errors_total counter');
    for (const [key, stats] of this.routes) {
      lines.push(`itam_request_errors_total{route="${escape(key)}"} ${stats.errors}`);
    }

    lines.push('# HELP itam_request_duration_ms Request duration.');
    lines.push('# TYPE itam_request_duration_ms histogram');
    for (const [key, stats] of this.routes) {
      const route = escape(key);
      let cumulative = 0;

      LATENCY_BUCKETS.forEach((limit, i) => {
        cumulative += stats.buckets[i]!;
        lines.push(`itam_request_duration_ms_bucket{route="${route}",le="${limit}"} ${cumulative}`);
      });

      cumulative += stats.buckets[LATENCY_BUCKETS.length]!;
      lines.push(`itam_request_duration_ms_bucket{route="${route}",le="+Inf"} ${cumulative}`);
      lines.push(`itam_request_duration_ms_sum{route="${route}"} ${stats.totalMs.toFixed(1)}`);
      lines.push(`itam_request_duration_ms_count{route="${route}"} ${stats.count}`);
    }

    if (this.counters.size > 0) {
      lines.push('# TYPE itam_events_total counter');
      for (const [name, value] of this.counters) {
        lines.push(`itam_events_total{name="${escape(name)}"} ${value}`);
      }
    }

    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE itam_${name} gauge`);
      lines.push(`itam_${name} ${value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  /** A readable summary, for the health endpoint and for humans. */
  summary(): Record<string, unknown> {
    let requests = 0;
    let errors = 0;
    let totalMs = 0;

    for (const stats of this.routes.values()) {
      requests += stats.count;
      errors += stats.errors;
      totalMs += stats.totalMs;
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requests,
      errors,
      errorRate: requests > 0 ? Number((errors / requests).toFixed(4)) : 0,
      meanDurationMs: requests > 0 ? Number((totalMs / requests).toFixed(1)) : 0,
      routes: this.routes.size,
    };
  }
}

/** Label values are quoted, so quotes, backslashes and newlines must escape. */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export const metrics = new Metrics();
