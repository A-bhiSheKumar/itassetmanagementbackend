import { Schema, type Model } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../db/index.js';

/**
 * Recurring work, claimed so it runs once per period no matter who asks.
 *
 * In production EventBridge invokes the jobs function every minute. Locally the
 * worker ticks on an interval. Either way several callers may reach the same
 * schedule at the same moment — an EventBridge retry, two local processes, an
 * overlapping invocation — and each schedule must still run exactly once per
 * period. An atomic claim on `lastRunAt` is what guarantees that; the caller's
 * own timing is not trusted at all.
 */

const scheduleRunSchema = markSchemaGlobal(
  new Schema(
    {
      name: { type: String, required: true },
      lastRunAt: { type: Date, required: true },
    },
    { timestamps: true },
  ),
);

scheduleRunSchema.index({ name: 1 }, { unique: true });

interface ScheduleRun {
  name: string;
  lastRunAt: Date;
}

export const ScheduleRunModel = defineModel('ScheduleRun', scheduleRunSchema) as unknown as Model<ScheduleRun>;

/**
 * True if this caller won the right to run `name` now.
 *
 * Matches a run older than one interval (or none at all) and stamps it in the
 * same operation, so of any number of simultaneous callers exactly one sees
 * `true`. A duplicate key on the first-ever run means another caller inserted
 * it first — they won.
 */
export async function claimSchedule(name: string, intervalMs: number, now = new Date()): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - intervalMs);

  try {
    const claimed = await ScheduleRunModel.findOneAndUpdate(
      { name, lastRunAt: { $lte: dueBefore } },
      { $set: { lastRunAt: now } },
      { upsert: true, new: false },
    ).exec();

    // `new: false` returns the document BEFORE the update: null means this was
    // an insert (first run ever), a document means we moved an overdue run.
    // Both are wins; the losing cases throw 11000 below.
    return claimed === null || claimed.lastRunAt <= dueBefore;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}
