import type Redis from 'ioredis';
import { logger } from '../../logging/index.js';
import type { RateLimitStore } from './rateLimit.middleware.js';

/**
 * Rate-limit counters shared across replicas.
 *
 * ── Why this matters ──────────────────────────────────────────────────────
 * With in-memory counters and N replicas, each enforces its own count, so a
 * limit of 300 is really 300×N — and it drifts every time the deployment
 * scales. A shared counter means the number in the config is the number that
 * is enforced.
 *
 * ── Fixed window, not sliding ─────────────────────────────────────────────
 * A fixed window lets a client send up to 2× the limit across a boundary
 * (all of one window's budget at its end, all of the next at its start). A
 * sliding window costs a sorted set per key and a ZREMRANGEBYSCORE per request.
 *
 * For abuse prevention the fixed window is the right trade: it bounds sustained
 * load, which is what actually threatens the service, and the burst it permits
 * is bounded and brief. The auth limits — where the burst would matter — are
 * small enough that 2× is still small.
 */

/**
 * INCR then EXPIRE, atomically.
 *
 * Two round trips would race: two requests can both see a count of 1 and both
 * set an expiry, or worse, a crash between them leaves a key with NO expiry —
 * which locks that client out permanently. The script makes it one operation.
 */
const HIT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('PTTL', KEYS[1])
  return {count, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  private scriptSha: string | null = null;
  private failing = false;

  constructor(private readonly client: Redis) {}

  /**
   * Synchronous, because the middleware interface is.
   *
   * The counter is read from a short-lived local cache and refreshed
   * asynchronously against Redis. That means a limit can be exceeded by a small
   * margin under a burst — the alternative is making every request wait on a
   * network round trip before it is even routed, which is a worse trade for
   * something whose job is to protect availability.
   */
  hit(key: string, windowMs: number): { count: number; resetAt: number } {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && cached.resetAt > now) {
      cached.count += 1;
      void this.syncToRedis(key, windowMs, cached);
      return cached;
    }

    const fresh = { count: 1, resetAt: now + windowMs };
    this.cache.set(key, fresh);
    void this.syncToRedis(key, windowMs, fresh);

    return fresh;
  }

  private readonly cache = new Map<string, { count: number; resetAt: number }>();

  private async syncToRedis(
    key: string,
    windowMs: number,
    local: { count: number; resetAt: number },
  ): Promise<void> {
    try {
      this.scriptSha ??= await this.client.script('LOAD', HIT_SCRIPT) as string;

      const [count, ttl] = (await this.client.evalsha(
        this.scriptSha,
        1,
        `rl:${key}`,
        String(windowMs),
      )) as [number, number];

      // Redis is the authority: adopt its count so every replica converges on
      // the same view within one request.
      local.count = Math.max(local.count, count);
      if (ttl > 0) local.resetAt = Date.now() + ttl;

      this.failing = false;
    } catch (err) {
      // Fail OPEN, loudly.
      //
      // Rate limiting protects availability; it must not become the thing that
      // removes it. A Redis outage that blocked every request would turn a
      // degraded dependency into a total one. The local counter still applies,
      // so limits keep working per-replica in the meantime.
      if (!this.failing) {
        this.failing = true;
        logger.error({ err }, 'Rate-limit store unavailable — falling back to per-replica counts');
      }

      // A stale sha after a Redis restart: forget it and reload next time.
      this.scriptSha = null;
    }
  }

  /** Drops expired local entries. Redis expires its own via PEXPIRE. */
  sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.cache) {
      if (window.resetAt <= now) this.cache.delete(key);
    }
  }
}
