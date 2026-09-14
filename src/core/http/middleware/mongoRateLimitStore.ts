import { Schema, type Model } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../db/index.js';
import { logger } from '../../logging/index.js';
import type { RateLimitStore, RateLimitWindow } from './rateLimit.middleware.js';

/**
 * Rate-limit counters that every Lambda container sees.
 *
 * On Lambda each concurrent invocation is its own container with its own memory,
 * so an in-memory counter of 10 sign-in attempts is really 10 per container —
 * which under load is barely a limit at all. Counting in MongoDB means the
 * number in the config is the number enforced.
 *
 * ── Fixed windows, one document each ──────────────────────────────────────
 * The window's start time is part of the document id, so a hit is a single
 * atomic upsert-and-increment: no read-then-write race, and no cleanup job —
 * each document expires with its window. A fixed window allows up to twice the
 * limit across a boundary; for the limits that use this (sign-in, invitations,
 * exports) that bound is still small, and a sliding window would cost a read
 * per request for no real protection.
 *
 * Reserved for the limits where abuse is cheap and the count must be right.
 * General traffic is throttled at API Gateway, because a database write on
 * every single request is a poor trade for a best-effort ceiling.
 */

const rateLimitHitSchema = markSchemaGlobal(
  new Schema(
    {
      _id: { type: String, required: true },
      count: { type: Number, default: 0 },
      expiresAt: { type: Date, required: true },
    },
    { versionKey: false },
  ),
);

rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

interface RateLimitHit {
  _id: string;
  count: number;
  expiresAt: Date;
}

export const RateLimitHitModel = defineModel('RateLimitHit', rateLimitHitSchema) as unknown as Model<RateLimitHit>;

export class MongoRateLimitStore implements RateLimitStore {
  private failing = false;

  async hit(key: string, windowMs: number): Promise<RateLimitWindow> {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetAt = windowStart + windowMs;
    const id = `${key}:${windowStart}`;

    // Two attempts: two first hits in the same window can both try to insert,
    // and the loser's duplicate-key error just means the document now exists.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const doc = await RateLimitHitModel.findOneAndUpdate(
          { _id: id },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt) } },
          { upsert: true, new: true },
        )
          .lean()
          .exec();

        this.failing = false;
        return { count: doc?.count ?? 1, resetAt };
      } catch (err) {
        if ((err as { code?: number }).code === 11000 && attempt === 1) continue;

        /*
         * Fail OPEN, and say so once.
         *
         * Rate limiting protects availability; it must not become the thing
         * that removes it. If the database cannot count a hit, the request it
         * belongs to is almost certainly failing anyway — and the per-account
         * lockout, stored on the user, still applies to sign-in.
         */
        if (!this.failing) {
          this.failing = true;
          logger.error({ err }, 'Shared rate-limit store unavailable — letting requests through');
        }
        return { count: 0, resetAt };
      }
    }

    return { count: 0, resetAt };
  }
}
