import { AssetModel } from '../assets/index.js';
import { AssignmentModel } from '../assignments/index.js';
import { PersonModel } from '../people/index.js';
import { MaintenanceModel, overdueFilter as maintenanceOverdue } from '../maintenance/index.js';
import { LicenceModel } from '../licences/index.js';
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

const OVERDUE_FILTER = () => ({ status: 'active', dueAt: { $type: 'date', $lt: new Date() } });

/** Active licences ending inside the horizon, or ended within it — a lapsed licence is still a problem. */
const RENEWAL_FILTER = () => ({
  status: 'active',
  expiresAt: { $type: 'date', $gte: new Date(Date.now() - HORIZON_DAYS * 86_400_000), $lte: new Date(Date.now() + HORIZON_DAYS * 86_400_000) },
});

const DAMAGED_FILTER = { condition: 'damaged', lifecycleState: { $nin: ['disposed', 'retired'] } };

export async function warrantyPipeline(horizonDays = HORIZON_DAYS): Promise<ExpiringWarranty[]> {
  const horizon = new Date(Date.now() + horizonDays * 86_400_000);

  // A disposed or lost asset's warranty is nobody's problem.
  /**
   * `$type: 'date'` rather than `$ne: null`, deliberately.
   *
   * The index is partial on `{'warranty.expiresAt': {$type: 'date'}}`, and
   * MongoDB uses a partial index only when the query PROVABLY implies its
   * filter. `$ne: null` does not imply "is a date", so the planner refused the
   * index and fell back to scanning: 2,000 documents examined instead of 300
   * for the same 300 results, and 90ms of the dashboard's 103ms at 100k assets.
   */
  const rows = await AssetModel.find({
    'warranty.expiresAt': { $type: 'date', $lte: horizon },
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

  const [overdue, maintenanceDue, renewals, expiring, unacknowledged, offboarding, damaged] = await Promise.all([
    AssignmentModel.countDocuments(OVERDUE_FILTER()),
    MaintenanceModel.countDocuments(maintenanceOverdue()),
    LicenceModel.countDocuments(RENEWAL_FILTER()),
    // See the note in warrantyPipeline: $type is what lets the partial index
    // serve this. It is the difference between 90ms and 2ms here.
    AssetModel.countDocuments({
      'warranty.expiresAt': { $type: 'date', $lte: horizon },
      lifecycleState: { $nin: ['disposed', 'lost', 'retired'] },
    }),
    AssignmentModel.countDocuments({
      status: 'active',
      'acknowledgement.requiredAt': { $ne: null },
      'acknowledgement.acknowledgedAt': null,
    }),
    PersonModel.countDocuments({ status: 'offboarding' }),
    AssetModel.countDocuments(DAMAGED_FILTER),
  ]);

  // Every row opens the inbox on its own tab, where each item can be acted on.
  // These used to link to list filters the lists did not support.
  const rows: AttentionRow[] = [
    { key: 'overdue', label: 'Assets overdue for return', count: overdue, href: '/attention?kind=overdue', tone: 'danger' },
    {
      key: 'offboarding',
      label: 'People being offboarded',
      count: offboarding,
      href: '/attention?kind=offboarding',
      tone: 'danger',
    },
    {
      key: 'maintenance',
      label: 'Maintenance past its date',
      count: maintenanceDue,
      href: '/attention?kind=maintenance',
      tone: 'warning',
    },
    {
      key: 'renewals',
      label: `Licences renewing or lapsed within ${HORIZON_DAYS} days`,
      count: renewals,
      href: '/attention?kind=renewals',
      tone: 'warning',
    },
    {
      key: 'warranties',
      label: `Warranties ending within ${HORIZON_DAYS} days`,
      count: expiring,
      href: '/attention?kind=warranties',
      tone: 'warning',
    },
    { key: 'damaged', label: 'Assets recorded as damaged', count: damaged, href: '/attention?kind=damaged', tone: 'warning' },
    {
      key: 'acknowledgements',
      label: 'Receipts not yet confirmed',
      count: unacknowledged,
      href: '/attention?kind=acknowledgements',
      tone: 'neutral',
    },
  ];

  // An empty attention panel is the goal, not a bug. Rows with nothing in them
  // are noise that teaches people to stop reading it.
  return rows.filter((row) => row.count > 0);
}

// ── The inbox ───────────────────────────────────────────────────────────────

export const ATTENTION_KINDS = ['overdue', 'offboarding', 'maintenance', 'renewals', 'warranties', 'damaged', 'acknowledgements'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * One thing someone should act on.
 *
 * A single shape for every kind, so the inbox renders one list. `days` is
 * signed from today: negative is overdue or already lapsed, positive is time
 * remaining, and for receipts it is how long they have waited.
 */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  date: Date | null;
  days: number | null;
  assetId: string | null;
  personId: string | null;
  personName: string | null;
  assignmentId: string | null;
  /** The maintenance record or licence the item is about, for those kinds. */
  recordId?: string | null;
}

const ITEM_LIMIT = 200;

async function names(personIds: string[], assetIds: string[]) {
  const [people, assets] = await Promise.all([
    personIds.length
      ? PersonModel.find({ _id: { $in: [...new Set(personIds)] } }).select('firstName lastName').lean()
      : Promise.resolve([]),
    assetIds.length
      ? AssetModel.find({ _id: { $in: [...new Set(assetIds)] } }).select('name assetTag').lean()
      : Promise.resolve([]),
  ]);

  return {
    person: new Map(people.map((p) => [String(p._id), `${p.firstName} ${p.lastName}`])),
    asset: new Map(assets.map((a) => [String(a._id), { name: a.name, tag: a.assetTag }])),
  };
}

async function assignmentItems(kind: 'overdue' | 'acknowledgements'): Promise<AttentionItem[]> {
  const filter =
    kind === 'overdue'
      ? OVERDUE_FILTER()
      : { status: 'active', 'acknowledgement.requiredAt': { $ne: null }, 'acknowledgement.acknowledgedAt': null };

  const rows = await AssignmentModel.find(filter)
    .sort(kind === 'overdue' ? { dueAt: 1 } : { 'acknowledgement.requiredAt': 1 })
    .limit(ITEM_LIMIT)
    .lean();

  const lookup = await names(
    rows.filter((r) => r.assigneeType === 'person').map((r) => r.assigneeId),
    rows.map((r) => r.assetId),
  );

  return rows.map((r) => {
    const asset = lookup.asset.get(r.assetId);
    const holder = r.assigneeType === 'person' ? (lookup.person.get(r.assigneeId) ?? null) : null;
    const date = kind === 'overdue' ? r.dueAt! : r.acknowledgement!.requiredAt!;

    return {
      id: String(r._id),
      kind,
      title: asset?.name ?? 'Deleted asset',
      // The holder travels separately as personName, so a client can link it.
      detail: asset?.tag ?? '',
      date,
      days: kind === 'overdue' ? daysUntil(date) : -daysUntil(date),
      assetId: r.assetId,
      personId: r.assigneeType === 'person' ? r.assigneeId : null,
      personName: holder,
      assignmentId: String(r._id),
    };
  });
}

/** The items behind one row of the attention panel, most urgent first. */
export async function attentionItems(kind: AttentionKind): Promise<AttentionItem[]> {
  if (kind === 'overdue' || kind === 'acknowledgements') return assignmentItems(kind);

  if (kind === 'maintenance') {
    const rows = await MaintenanceModel.find(maintenanceOverdue()).sort({ scheduledFor: 1 }).limit(ITEM_LIMIT).lean();
    const lookup = await names([], rows.map((r) => r.assetId));
    return rows.map((r) => ({
      id: String(r._id),
      kind,
      title: r.title,
      detail: [lookup.asset.get(r.assetId)?.name, lookup.asset.get(r.assetId)?.tag].filter(Boolean).join(' · '),
      date: r.scheduledFor ?? null,
      days: r.scheduledFor ? daysUntil(r.scheduledFor) : null,
      assetId: r.assetId,
      personId: null,
      personName: null,
      assignmentId: null,
      recordId: String(r._id),
    }));
  }

  if (kind === 'renewals') {
    const rows = await LicenceModel.find(RENEWAL_FILTER()).sort({ expiresAt: 1 }).limit(ITEM_LIMIT).lean();
    return rows.map((r) => ({
      id: String(r._id),
      kind,
      title: r.name,
      detail: [
        r.autoRenew ? 'Renews automatically' : 'Does not renew automatically',
        r.seats != null ? `${r.seatsUsed} of ${r.seats} seats used` : `${r.seatsUsed} seats used`,
      ].join(' · '),
      date: r.expiresAt ?? null,
      days: r.expiresAt ? daysUntil(r.expiresAt) : null,
      assetId: null,
      personId: null,
      personName: null,
      assignmentId: null,
      recordId: String(r._id),
    }));
  }

  if (kind === 'warranties') {
    const rows = await warrantyPipeline();
    return rows.map((r) => ({
      id: r.assetId,
      kind,
      title: r.name,
      detail: r.assetTag,
      date: r.expiresAt ?? null,
      days: r.daysRemaining,
      assetId: r.assetId,
      personId: null,
      personName: null,
      assignmentId: null,
    }));
  }

  if (kind === 'damaged') {
    const rows = await AssetModel.find(DAMAGED_FILTER)
      .sort({ updatedAt: -1 })
      .limit(ITEM_LIMIT)
      .select('name assetTag currentAssignment updatedAt')
      .lean();

    const holderOf = (r: (typeof rows)[number]) =>
      r.currentAssignment?.assigneeType === 'person' ? (r.currentAssignment.assigneeId ?? null) : null;
    const lookup = await names(rows.map(holderOf).filter((id): id is string => Boolean(id)), []);

    return rows.map((r) => {
      const holder = holderOf(r);
      const holderName = holder ? (lookup.person.get(holder) ?? null) : null;
      return {
        id: String(r._id),
        kind,
        title: r.name,
        detail: r.assetTag,
        date: r.updatedAt as Date,
        days: null,
        assetId: String(r._id),
        personId: holder,
        personName: holderName,
        assignmentId: r.currentAssignment?.assignmentId ?? null,
      };
    });
  }

  // Offboarding: who is leaving, and how much they still hold.
  const people = await PersonModel.find({ status: 'offboarding' })
    .sort({ endDate: 1 })
    .limit(ITEM_LIMIT)
    .select('firstName lastName jobTitle endDate')
    .lean();

  const holding = await AssignmentModel.aggregate<{ _id: string; n: number }>([
    { $match: { status: 'active', assigneeType: 'person', assigneeId: { $in: people.map((p) => String(p._id)) } } },
    { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
  ]);
  const held = new Map(holding.map((h) => [h._id, h.n]));

  return people.map((p) => {
    const outstanding = held.get(String(p._id)) ?? 0;
    const name = `${p.firstName} ${p.lastName}`;
    return {
      id: String(p._id),
      kind,
      title: name,
      detail: outstanding === 0 ? 'Nothing left to return' : `${outstanding} ${outstanding === 1 ? 'asset' : 'assets'} still to return`,
      date: (p.endDate as Date | null) ?? null,
      days: p.endDate ? daysUntil(p.endDate as Date) : null,
      assetId: null,
      personId: String(p._id),
      personName: name,
      assignmentId: null,
    };
  });
}
