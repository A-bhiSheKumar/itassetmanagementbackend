import { AssetModel } from '../assets/index.js';
import { AssignmentModel } from '../assignments/index.js';
import { PersonModel } from '../people/index.js';
import { MetricsDailyModel, type MetricsDaily } from './metricsDaily.model.js';

/** UTC midnight — the grain every rollup is keyed on. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function tally(rows: Array<{ _id: string | null; n: number }>): Record<string, number> {
  return Object.fromEntries(rows.filter((r) => r._id !== null).map((r) => [String(r._id), r.n]));
}

/**
 * Recomputes today's rollup for the current tenant.
 *
 * This is the expensive query, run once per tenant per night rather than on
 * every dashboard load. It is also idempotent, so it can be re-run freely.
 */
export async function rebuildDailyMetrics(): Promise<MetricsDaily> {
  const date = today();
  const in30Days = new Date(Date.now() + 30 * 86_400_000);

  const [byState, byCategory, byLocation, byCondition, value, assigned, people, expiring, unacknowledged] =
    await Promise.all([
      AssetModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$lifecycleState', n: { $sum: 1 } } },
      ]),
      AssetModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]),
      AssetModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$placement.locationId', n: { $sum: 1 } } },
      ]),
      AssetModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$condition', n: { $sum: 1 } } },
      ]),
      AssetModel.aggregate<{ _id: null; total: number }>([
        { $group: { _id: null, total: { $sum: '$purchase.priceMinor' } } },
      ]),
      AssetModel.countDocuments({ currentAssignment: { $ne: null } }),
      PersonModel.countDocuments({ status: 'active' }),
      AssetModel.countDocuments({
        'warranty.expiresAt': { $ne: null, $lte: in30Days },
        lifecycleState: { $nin: ['disposed', 'lost', 'retired'] },
      }),
      AssignmentModel.countDocuments({
        status: 'active',
        'acknowledgement.requiredAt': { $ne: null },
        'acknowledgement.acknowledgedAt': null,
      }),
    ]);

  const states = tally(byState);
  const totalAssets = Object.values(states).reduce((sum, n) => sum + n, 0);

  const metrics = {
    totalAssets,
    assignedAssets: assigned,
    availableAssets: totalAssets - assigned,
    byState: states,
    byCategory: tally(byCategory),
    byLocation: tally(byLocation),
    byCondition: tally(byCondition),
    totalValueMinor: value[0]?.total ?? 0,
    peopleCount: people,
    expiringWarranties30d: expiring,
    unacknowledgedAssignments: unacknowledged,
    computedAt: new Date(),
  };

  await MetricsDailyModel.updateOne({ date }, { $set: metrics }, { upsert: true });

  return (await MetricsDailyModel.findOne({ date }).lean())!;
}

/**
 * Today's figures, computing them if the rollup has not run yet.
 *
 * A new tenant, or one whose first day this is, would otherwise see an empty
 * dashboard and conclude the product is broken.
 */
export async function currentMetrics(): Promise<MetricsDaily> {
  const existing = await MetricsDailyModel.findOne({ date: today() }).lean();
  return existing ?? (await rebuildDailyMetrics());
}

/** Day-by-day history for trend lines. */
export async function metricsHistory(days = 30): Promise<MetricsDaily[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  return MetricsDailyModel.find({ date: { $gte: since } }).sort({ date: 1 }).lean();
}
