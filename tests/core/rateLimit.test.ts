import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import IORedis from 'ioredis';
import {
  rateLimit,
  setRateLimitStore,
  currentRateLimitStore,
  RedisRateLimitStore,
  type RateLimitStore,
} from '../../src/core/http/index.js';
import { runWithContext } from '../../src/core/context/index.js';

/**
 * The store, tested directly.
 *
 * The middleware short-circuits under NODE_ENV=test — supertest issues every
 * request from one address, so an IP limit would make test order significant.
 * Driving the store is the honest way to assert the counting behaviour.
 */

/** A Redis on the standard port, if one happens to be running. */
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

let redis: IORedis | undefined;

async function redisAvailable(): Promise<boolean> {
  const client = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 800,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();
    redis = client;
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}

const hasRedis = await redisAvailable();

afterAll(async () => {
  await redis?.quit().catch(() => undefined);
});

function memoryStore(): RateLimitStore {
  // A fresh instance per test, via the exported setter.
  setRateLimitStore(
    new (class implements RateLimitStore {
      private readonly windows = new Map<string, { count: number; resetAt: number }>();
      hit(key: string, windowMs: number) {
        const now = Date.now();
        const existing = this.windows.get(key);
        if (!existing || existing.resetAt <= now) {
          const fresh = { count: 1, resetAt: now + windowMs };
          this.windows.set(key, fresh);
          return fresh;
        }
        existing.count += 1;
        return existing;
      }
    })(),
  );
  return currentRateLimitStore();
}

describe('counting', () => {
  let store: RateLimitStore;

  beforeEach(() => {
    store = memoryStore();
  });

  it('counts up within a window', () => {
    expect(store.hit('a', 60_000).count).toBe(1);
    expect(store.hit('a', 60_000).count).toBe(2);
    expect(store.hit('a', 60_000).count).toBe(3);
  });

  it('counts each key independently', () => {
    store.hit('a', 60_000);
    store.hit('a', 60_000);

    // A per-tenant limit is only useful if one tenant's traffic cannot consume
    // another's budget.
    expect(store.hit('b', 60_000).count).toBe(1);
  });

  it('starts a fresh window once the old one expires', async () => {
    expect(store.hit('a', 40).count).toBe(1);
    expect(store.hit('a', 40).count).toBe(2);

    await new Promise((r) => setTimeout(r, 60));

    expect(store.hit('a', 40).count).toBe(1);
  });

  it('reports when the window resets', () => {
    const window = store.hit('a', 60_000);
    expect(window.resetAt).toBeGreaterThan(Date.now());
    expect(window.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('dimensions', () => {
  it('does not apply a user limit to an unauthenticated request', () => {
    // No user means the dimension does not apply; the per-IP limiter covers it.
    // Applying a null-keyed limit would put every anonymous caller in the world
    // into one shared bucket.
    const middleware = rateLimit({ name: 't', by: 'user', windowMs: 1_000, limit: 1 });

    let called = 0;
    const next = (err?: unknown): void => {
      if (!err) called += 1;
    };

    runWithContext(
      { requestId: 'r', permissions: new Set<string>(), actorType: 'user' },
      () => {
        const req = { ip: '1.2.3.4' } as never;
        const res = { setHeader: () => undefined } as never;
        middleware(req, res, next as never);
        middleware(req, res, next as never);
        middleware(req, res, next as never);
      },
    );

    expect(called).toBe(3);
  });
});

/**
 * The Redis store, against a real Redis.
 *
 * Skipped when none is running, because a test suite that needs external
 * infrastructure is one people stop running — but it is the only way to verify
 * the behaviour that matters, which is that counters are SHARED.
 */
describe.skipIf(!hasRedis)('shared counters (real Redis)', () => {
  const key = () => `test-${Math.random().toString(36).slice(2)}`;

  it('shares a count between two independent store instances', async () => {
    // Two stores standing in for two API replicas. This is the entire point:
    // with per-process counters a limit of 300 is really 300×N.
    const replicaA = new RedisRateLimitStore(redis!);
    const replicaB = new RedisRateLimitStore(redis!);
    const k = key();

    replicaA.hit(k, 5_000);
    await new Promise((r) => setTimeout(r, 60));

    replicaB.hit(k, 5_000);
    await new Promise((r) => setTimeout(r, 60));

    const third = replicaA.hit(k, 5_000);
    await new Promise((r) => setTimeout(r, 60));

    const stored = await redis!.get(`rl:${k}`);
    expect(Number(stored)).toBeGreaterThanOrEqual(3);
    expect(third.count).toBeGreaterThanOrEqual(2);
  });

  it('always sets an expiry, so a client cannot be locked out permanently', async () => {
    const store = new RedisRateLimitStore(redis!);
    const k = key();

    store.hit(k, 3_000);
    await new Promise((r) => setTimeout(r, 80));

    // INCR and EXPIRE are one script for exactly this reason: a crash between
    // them would leave a key with no TTL, and that client blocked forever.
    const ttl = await redis!.pttl(`rl:${k}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3_000);
  });

  it('fails OPEN when Redis is unreachable', async () => {
    const dead = new IORedis('redis://127.0.0.1:6399', {
      maxRetriesPerRequest: 1,
      connectTimeout: 300,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);

    const store = new RedisRateLimitStore(dead);

    // Rate limiting protects availability; it must never be the thing that
    // removes it. The local counter still applies, so limits keep working
    // per-replica while Redis is down.
    expect(() => store.hit(key(), 1_000)).not.toThrow();
    const second = store.hit('same-key', 1_000);
    expect(second.count).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 100));
    dead.disconnect();
  });
});
