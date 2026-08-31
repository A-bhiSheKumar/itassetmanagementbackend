import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, upsertWithRetry, type Scoped } from '../../core/db/index.js';

/**
 * Atomic sequences for asset tags.
 *
 * Exists for one reason: generating a tag from `count() + 1` or `max + 1`
 * RACES. Two concurrent creates read the same value and produce LAP-0042
 * twice — which the unique index then rejects, so the second create fails for
 * a reason that has nothing to do with what the user did. It happens reliably
 * during a parallel import.
 *
 * `findOneAndUpdate` with `$inc` and `upsert` is a single atomic operation.
 */
const counterSchema = new Schema({
  key: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export type Counter = Scoped<InferSchemaType<typeof counterSchema>>;

export const CounterModel = defineModel('Counter', counterSchema) as unknown as Model<Counter>;

/**
 * Returns the next value for `key`, atomically. Never returns the same twice.
 *
 * Wrapped in upsertWithRetry because the FIRST calls for a key race to create
 * the counter document and all but one get a duplicate-key error. Once it
 * exists this is a pure $inc, which is atomic and conflict-free.
 */
export async function nextSequence(key: string): Promise<number> {
  const counter = await upsertWithRetry(() =>
    CounterModel.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', new: true },
    ).exec(),
  );

  return counter!.seq;
}
