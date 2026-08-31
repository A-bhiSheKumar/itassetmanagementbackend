import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getContext } from '../../context/index.js';
import { AppError, ErrorCode } from '../../errors/index.js';
import { isTest } from '../../../config/index.js';

/**
 * Rate limiting on three independent dimensions (docs/04-api-design.md §8).
 *
 * Per IP, per user, and per TENANT — the last of these is what stops one noisy
 * customer degrading everyone else's service. A single global limit protects
 * the server and nobody else; a per-IP limit alone is defeated by a tenant
 * behind one NAT.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 * In memory here, which is correct for a single process and wrong for several:
 * with N replicas each enforces its own counter, so the effective limit is N
 * times what it says. Redis-backed counters are the fix and the interface below
 * is shaped for it; until then the numbers are deliberately conservative and
 * the auth limits — the ones that actually matter — are the tightest.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Window;
}

class MemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number): Window {
    const now = Date.now();
    this.sweep(now);

    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return fresh;
    }

    existing.count += 1;
    return existing;
  }

  /**
   * Drops expired windows periodically.
   *
   * Without this the map grows one entry per distinct key forever — which for a
   * per-IP limit is one entry per client that has ever connected.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

const store: RateLimitStore = new MemoryStore();

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Which dimension to count on. */
  by: 'ip' | 'user' | 'tenant';
  name: string;
}

function keyFor(req: Request, by: RateLimitOptions['by']): string | null {
  const ctx = getContext();

  if (by === 'ip') return req.ip ?? 'unknown';
  if (by === 'user') return ctx?.userId ?? null;
  return ctx?.tenantId ?? null;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Supertest issues every request from one address, so an IP limit would
    // make test order significant. The auth-specific limits are asserted
    // separately with the store driven directly.
    if (isTest) return next();

    const dimension = keyFor(req, options.by);

    // No key means the dimension does not apply to this request — an
    // unauthenticated call has no user or tenant. Another limiter covers it.
    if (!dimension) return next();

    const key = `${options.name}:${options.by}:${dimension}`;
    const window = store.hit(key, options.windowMs);

    const remaining = Math.max(0, options.limit - window.count);
    const resetSeconds = Math.ceil((window.resetAt - Date.now()) / 1000);

    res.setHeader('RateLimit-Limit', options.limit);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (window.count > options.limit) {
      res.setHeader('Retry-After', resetSeconds);

      next(
        new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.', {
          details: { limit: options.limit, windowMs: options.windowMs, retryAfterSeconds: resetSeconds },
        }),
      );
      return;
    }

    next();
  };
}

/**
 * The standing limits.
 *
 * Deliberately generous for ordinary use and tight where abuse is cheap:
 * exports and imports are expensive to serve, and invitations are a spam
 * vector that costs us deliverability rather than CPU.
 */
export const limits = {
  perUser: rateLimit({ name: 'api', by: 'user', windowMs: 60_000, limit: 300 }),
  perTenant: rateLimit({ name: 'api', by: 'tenant', windowMs: 60_000, limit: 1_000 }),
  perIp: rateLimit({ name: 'api', by: 'ip', windowMs: 60_000, limit: 600 }),

  heavy: rateLimit({ name: 'heavy', by: 'tenant', windowMs: 3_600_000, limit: 20 }),
  invitations: rateLimit({ name: 'invite', by: 'tenant', windowMs: 86_400_000, limit: 50 }),
};

export { store as rateLimitStore };
