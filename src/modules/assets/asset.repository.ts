import { getContext } from '../../core/context/index.js';
import { subtreeIds, ORG_UNIT_MODELS } from '../people/index.js';
import { AssetModel, type AssetDocument } from './asset.model.js';

/**
 * Query building for the asset list.
 *
 * The only place that constructs asset filters. Services never build queries
 * and controllers never see Mongoose — that separation is what keeps the
 * scoping rules below in exactly one place.
 */

export interface AssetFilters {
  lifecycleState?: string;
  assetTypeId?: string;
  categoryId?: string;
  locationId?: string;
  departmentId?: string;
  condition?: string;
  assigneeId?: string;
  /** `true` = unassigned only, `false` = assigned only. */
  unassigned?: boolean;
  q?: string;
  /** Custom field filters, already parsed: `cf.n.ram_gb` → `{ $gte: 16 }`. */
  customFilters?: Record<string, unknown>;
  warrantyExpiringBefore?: Date;
}

/**
 * The extra clause a department- or location-scoped role contributes.
 *
 * Applied to list queries AND to record lookups, so a scoped user's list and
 * their detail access can never disagree — the version of this bug that shows a
 * row the user then cannot open.
 */
export async function assetScopeFilter(): Promise<Record<string, unknown>> {
  const scope = getContext()?.scope;
  if (!scope || scope.type === 'all') return {};

  if (scope.type === 'location' && scope.locationIds?.length) {
    const ids = await subtreeIds(ORG_UNIT_MODELS.location, scope.locationIds);
    return { 'placement.locationId': { $in: ids } };
  }

  if (scope.type === 'department' && scope.departmentIds?.length) {
    const ids = await subtreeIds(ORG_UNIT_MODELS.department, scope.departmentIds);
    return { 'placement.departmentId': { $in: ids } };
  }

  return {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function buildAssetFilter(filters: AssetFilters): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { ...(await assetScopeFilter()) };

  if (filters.lifecycleState) {
    // Comma-separated values are OR within one field (docs/04 §3).
    const states = filters.lifecycleState.split(',').map((s) => s.trim()).filter(Boolean);
    filter.lifecycleState = states.length > 1 ? { $in: states } : states[0];
  }

  if (filters.assetTypeId) filter.assetTypeId = filters.assetTypeId;
  if (filters.categoryId) filter.categoryId = filters.categoryId;
  if (filters.locationId) filter['placement.locationId'] = filters.locationId;
  if (filters.departmentId) filter['placement.departmentId'] = filters.departmentId;
  if (filters.condition) filter.condition = filters.condition;

  if (filters.assigneeId) filter['currentAssignment.assigneeId'] = filters.assigneeId;
  if (filters.unassigned === true) filter.currentAssignment = null;
  if (filters.unassigned === false) filter.currentAssignment = { $ne: null };

  if (filters.warrantyExpiringBefore) {
    filter['warranty.expiresAt'] = { $lte: filters.warrantyExpiringBefore, $ne: null };
  }

  if (filters.q) {
    filter.searchTokens = new RegExp(`^${escapeRegExp(filters.q.toLowerCase())}`);
  }

  // Custom field filters go straight onto their bucketed paths, which the
  // compound wildcard index covers.
  if (filters.customFilters) Object.assign(filter, filters.customFilters);

  return filter;
}

export interface CursorPage<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { c: string; i: string };
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.i };
  } catch {
    // A malformed cursor is a client bug. Returning page one is recoverable;
    // a 500 is not.
    return null;
  }
}

export async function listAssets(options: {
  filters: AssetFilters;
  limit: number;
  cursor?: string;
  sort?: string;
}): Promise<CursorPage<AssetDocument>> {
  const filter = await buildAssetFilter(options.filters);

  // Cursor pagination over {createdAt, _id} (ADR-010). Offsets make Mongo walk
  // every skipped document and shift under concurrent writes.
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      filter.$or = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
      ];
    }
  }

  const rows = await AssetModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(options.limit + 1)
    .exec();

  // One extra row answers "is there more?" without a second query.
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    cursor: hasMore && last ? encodeCursor(last.createdAt as Date, String(last._id)) : null,
  };
}

export async function countByState(): Promise<Record<string, number>> {
  const rows = await AssetModel.aggregate<{ _id: string; n: number }>([
    { $group: { _id: '$lifecycleState', n: { $sum: 1 } } },
  ]);

  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}
