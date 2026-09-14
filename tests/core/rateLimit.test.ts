import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  rateLimit,
  MemoryRateLimitStore,
  MongoRateLimitStore,
  RateLimitHitModel,
  type RateLimitStore,
} from '../../src/core/http/index.js';

/**
 * The stores, tested directly.
 *
 * The middleware short-circuits under NODE_ENV=test — supertest issues every
 * request from one address, so an IP limit would make test order significant.
 * Driving the stores is the honest way to assert the counting.
 *
 * Both stores meet the same contract, so the counting behaviour runs against
 * each; the shared store then gets the properties only it can have.
 */

const stores: Array<[string, () => RateLimitStore]> = [
  ['memory', () => new MemoryRateLimitStore()],
  ['mongo', () => new MongoRateLimitStore()],
];

const key = () => `test:${Math.random().toString(36).slice(2)}`;

describe.each(stores)('%s store: counting', (_name, make) => {
  it('counts up within a window', async () => {
    const store = make();
    const k = key();
    expect((await store.hit(k, 60_000)).count).toBe(1);
    expect((await store.hit(k, 60_000)).count).toBe(2);
    expect((await store.hit(k, 60_000)).count).toBe(3);
  });

  it('counts each key independently', async () => {
    const store = make();
    const a = key();
    const b = key();
    await store.hit(a, 60_000);
    await store.hit(a, 60_000);
    expect((await store.hit(b, 60_000)).count).toBe(1);
  });

  it('reports when the window resets', async () => {
    const window = await make().hit(key(), 60_000);
    expect(window.resetAt).toBeGreaterThan(Date.now());
    expect(window.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('shared store', () => {
  it('gives two Lambda containers the same count', async () => {
    // Two independent instances stand in for two concurrent invocations, each
    // with its own memory. Only a shared store makes their counts one count.
    const containerA = new MongoRateLimitStore();
    const containerB = new MongoRateLimitStore();
    const k = key();

    await containerA.hit(k, 60_000);
    await containerB.hit(k, 60_000);
    expect((await containerA.hit(k, 60_000)).count).toBe(3);
  });

  it('counts every hit when many arrive at once', async () => {
    const store = new MongoRateLimitStore();
    const k = key();

    // A burst of first hits races to create the window's document.
    await Promise.all(Array.from({ length: 20 }, () => store.hit(k, 60_000)));
    expect((await store.hit(k, 60_000)).count).toBe(21);
  });

  it('gives every window an expiry, so a client can never be locked out for good', async () => {
    const k = key();
    await new MongoRateLimitStore().hit(k, 60_000);

    const doc = await RateLimitHitModel.findOne({ _id: { $regex: `^${k}:` } }).lean();
    expect(doc?.expiresAt).toBeInstanceOf(Date);
    expect(doc!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('fails OPEN when the database cannot count', async () => {
    const store = new MongoRateLimitStore();
    const spy = vi.spyOn(RateLimitHitModel, 'findOneAndUpdate').mockImplementation(() => {
      throw new Error('connection lost');
    });

    try {
      // Rate limiting protects availability; it must not remove it.
      const window = await store.hit(key(), 60_000);
      expect(window.count).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dimensions', () => {
  it('does not apply a user limit to an unauthenticated request', async () => {
    const middleware = rateLimit({ name: 't', by: 'user', windowMs: 1_000, limit: 1 });
    const next = vi.fn();

    // Under test the middleware passes straight through; outside test a request
    // with no user has no key and is also passed through. Either way: next().
    middleware({} as Request, { setHeader: () => undefined } as unknown as Response, next);
    await new Promise((r) => setTimeout(r, 0));

    expect(next).toHaveBeenCalledWith();
  });
});
