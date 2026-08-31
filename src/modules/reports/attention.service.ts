import { AssetModel } from '../assets/index.js';
import { AssignmentModel } from '../assignments/index.js';
import { PersonModel } from '../people/index.js';
import { daysUntil } from '../../shared/format.js';

/**
 * The "Needs attention" panel — the most valuable thing on the dashboard.
 *
 * Everything here is a live query, not a rollup, because each row is a small
 * bounded set that someone is expected to act on today. Rolling these up would
 * make them stale by exactly the interval that matters.
 */

export interface AttentionRow {
  key: string;
  label: string;
  count: number;
  /** Where clicking it goes — a pre-filtered list, never a dead end. */
  href: string;
  tone: 'neutral' | 'warning' | 'danger';
}

export interface ExpiringWarranty {
  assetId: string;
  assetTag: string;
  name: string;
  expiresAt: Date;
  daysRemaining: number;
}

const HORIZON_DAYS = 30;

export async function warrantyPipeline(horizonDays = HORIZON_DAYS): Promise<ExpiringWarranty[]> {
  const horizon = new Date(Date.now() + horizonDays * 86_400_000);

  const rows = await AssetModel.find({
    'warranty.expiresAt': { $ne: null, $lte: horizon },
    // A disposed or lost asset's warranty is nobody's problem.
    lifecycleState: { $nin: ['disposed', 'lost', 'retired'] },
  })
    .sort({ 'warranty.expiresAt': 1 })
    .limit(100)
    .select('assetTag name warranty.expiresAt')
    .lean();

  return rows.map((row) => ({
    assetId: String(row._id),
    assetTag: row.assetTag,
    name: row.name,
    expiresAt: row.warranty!.expiresAt!,
    daysRemaining: daysUntil(row.warranty!.expiresAt!),
  }));
}

export async function needsAttention(): Promise<AttentionRow[]> {
  const horizon = new Date(Date.now() + HORIZON_DAYS * 86_400_000);

  const [expiring, unacknowledged, offboarding, damaged] = await Promise.all([
    AssetModel.countDocuments({
      'warranty.expiresAt': { $ne: null, $lte: horizon },
      lifecycleState: { $nin: ['disposed', 'lost', 'retired'] },
    }),
    AssignmentModel.countDocuments({
      status: 'active',
      'acknowledgement.requiredAt': { $ne: null },
      'acknowledgement.acknowledgedAt': null,
    }),
    PersonModel.countDocuments({ status: 'offboarding' }),
    AssetModel.countDocuments({
      condition: 'damaged',
      lifecycleState: { $nin: ['disposed', 'retired'] },
    }),
  ]);

  const rows: AttentionRow[] = [
    {
      key: 'warranties',
      label: `Warranties expiring in ${HORIZON_DAYS} days`,
      count: expiring,
      href: `/assets?warrantyWithinDays=${HORIZON_DAYS}`,
      tone: 'warning',
    },
    {
      key: 'acknowledgements',
      label: 'Assignments awaiting acknowledgement',
      count: unacknowledged,
      href: '/assignments?unacknowledged=true',
      tone: 'neutral',
    },
    {
      key: 'offboarding',
      label: 'People offboarding with assets outstanding',
      count: offboarding,
      href: '/people?status=offboarding',
      tone: 'danger',
    },
    {
      key: 'damaged',
      label: 'Assets recorded as damaged',
      count: damaged,
      href: '/assets?condition=damaged',
      tone: 'warning',
    },
  ];

  // An empty attention panel is the goal, not a bug. Rows with nothing in them
  // are noise that teaches people to stop reading it.
  return rows.filter((row) => row.count > 0);
}
