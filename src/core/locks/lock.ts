import { Schema, type Model } from 'mongoose';
import { ulid } from 'ulid';
import { defineModel, markSchemaGlobal } from '../db/index.js';

/**
 * A lock that holds across processes.
 *
 * The import commit lock used to be a `Map` in memory. That never serialised
 * imports across two workers, and on Lambda — where every concurrent invocation
 * is its own container — it would serialise nothing at all, reopening the
 * duplicate-creation bug it existed to prevent (docs/06-edge-cases.md #36).
 *
 * A document with a unique key is the lock. It expires on its own (TTL plus an
 * explicit `expiresAt` check), so a holder that dies cannot block the key
 * forever; a live holder must finish, or renew, inside the TTL.
 *
 * Global: the key encodes the tenant where it matters, and a lock is taken
 * before any tenant context exists.
 */

const lockSchema = markSchemaGlobal(
  new Schema(
    {
      key: { type: String, required: true },
      holder: { type: String, required: true },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: true },
  ),
);

lockSchema.index({ key: 1 }, { unique: true });
// MongoDB's TTL monitor runs about once a minute, so it is a backstop. The
// acquire query checks `expiresAt` itself and does not wait for it.
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

interface Lock {
  key: string;
  holder: string;
  expiresAt: Date;
}

export const LockModel = defineModel('Lock', lockSchema) as unknown as Model<Lock>;

/**
 * Takes the lock, or returns null if someone else holds it.
 *
 * One atomic upsert: matches a lapsed lock or one this holder already has, and
 * a duplicate-key error means a live lock belongs to someone else. Re-entrant
 * for the same holder, so a retried job does not lock itself out.
 */
export async function acquireLock(key: string, ttlMs: number, holder = ulid()): Promise<string | null> {
  const now = new Date();

  try {
    await LockModel.findOneAndUpdate(
      { key, $or: [{ expiresAt: { $lte: now } }, { holder }] },
      { $set: { holder, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true, new: true },
    ).exec();
    return holder;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  }
}

/** Releases only if still held by `holder` — never someone else's lock. */
export async function releaseLock(key: string, holder: string): Promise<void> {
  await LockModel.deleteOne({ key, holder }).exec();
}
