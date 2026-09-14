import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { flattenCustomFields, availableTransitions, AssetTypeModel } from '../catalog/index.js';
import { assetTimeline } from '../timeline/index.js';
import { PersonModel, LocationModel } from '../people/index.js';
import { userDirectory } from '../memberships/index.js';
import type { AssetDocument } from './asset.model.js';
import * as service from './asset.service.js';
import { listAssets, countByState, type AssetFilters } from './asset.repository.js';

function present(asset: AssetDocument) {
  return {
    id: String(asset._id),
    assetTag: asset.assetTag,
    name: asset.name,
    description: asset.description,
    assetTypeId: asset.assetTypeId,
    categoryId: asset.categoryId,
    // Three orthogonal axes, presented as three fields (ADR-006).
    lifecycleState: asset.lifecycleState,
    condition: asset.condition,
    currentAssignment: asset.currentAssignment,
    serialNumber: asset.serialNumber,
    model: asset.model,
    brand: asset.brand,
    purchase: asset.purchase,
    warranty: asset.warranty,
    placement: asset.placement,
    parentAssetId: asset.parentAssetId,
    customFields: flattenCustomFields(asset.cf as never),
    version: asset.__v,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/**
 * Names the current holder of each asset.
 *
 * The cached pointer stores ids, which is right for a record and useless for a
 * screen. The console used to resolve them against the first hundred people it
 * had loaded — so in any organisation larger than that, holders past the
 * hundredth showed as "Unknown". One batched lookup per kind, whatever the page
 * size.
 */
async function withHolderNames(assets: AssetDocument[]) {
  const idsOf = (type: string) => [
    ...new Set(
      assets
        .map((a) => a.currentAssignment)
        .filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.assigneeType === type)
        .map((c) => c.assigneeId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];

  const [people, locations, parents] = await Promise.all([
    idsOf('person').length ? PersonModel.find({ _id: { $in: idsOf('person') } }).select('firstName lastName').lean() : [],
    idsOf('location').length ? LocationModel.find({ _id: { $in: idsOf('location') } }).select('name').lean() : [],
    idsOf('asset').length ? service.findAssetsByIds(idsOf('asset')) : [],
  ]);

  const names = new Map<string, string>([
    ...people.map((p) => [String(p._id), `${p.firstName} ${p.lastName}`] as [string, string]),
    ...locations.map((l) => [String(l._id), l.name] as [string, string]),
    ...parents.map((a) => [String(a._id), a.name] as [string, string]),
  ]);

  return assets.map((asset) => {
    const presented = present(asset);
    if (!asset.currentAssignment) return presented;

    // A Mongoose subdocument keeps its fields behind getters, so spreading it
    // copies nothing — the holder's id vanished from the response until this
    // converted it to a plain object first.
    const current = (asset.currentAssignment as unknown as { toObject?: () => Record<string, unknown> }).toObject?.() ??
      (asset.currentAssignment as unknown as Record<string, unknown>);

    return asset.currentAssignment
      ? {
          ...presented,
          currentAssignment: {
            ...current,
            // Null when the holder has since been deleted: the record outlives them.
            assigneeName: names.get(asset.currentAssignment.assigneeId ?? '') ?? null,
          },
        }
      : presented;
  });
}

/**
 * Extracts custom-field filters from the query string.
 *
 * `filter[cf.n.ram_gb][gte]=16` becomes `{ 'cf.n.ram_gb': { $gte: 16 } }`. The
 * value is coerced by BUCKET, which is the whole reason values are stored by
 * type: a numeric bucket compares as a number, a date bucket as a date.
 */
const OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']);

export function parseCustomFilters(query: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const raw = query.filter as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return filters;

  for (const [path, condition] of Object.entries(raw)) {
    if (!path.startsWith('cf.')) continue;

    const bucket = path.split('.')[1];
    const coerce = (v: unknown): unknown => {
      if (bucket === 'n') return Number(v);
      if (bucket === 'd') return new Date(String(v));
      if (bucket === 'b') return v === 'true' || v === true;
      return v;
    };

    if (typeof condition === 'string') {
      filters[path] = coerce(condition);
      continue;
    }

    if (condition && typeof condition === 'object') {
      const built: Record<string, unknown> = {};
      for (const [op, value] of Object.entries(condition as Record<string, unknown>)) {
        // Only known operators. Otherwise a query string becomes a way to
        // inject arbitrary Mongo operators.
        if (!OPERATORS.has(op)) continue;
        built[`$${op}`] =
          op === 'in' || op === 'nin'
            ? String(value).split(',').map(coerce)
            : coerce(value);
      }
      if (Object.keys(built).length > 0) filters[path] = built;
    }
  }

  return filters;
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as AssetFilters & { limit: number; cursor?: string };

  const result = await listAssets({
    filters: { ...query, customFilters: parseCustomFilters(req.query as Record<string, unknown>) },
    limit: query.limit,
    cursor: query.cursor,
  });

  list(res, await withHolderNames(result.items), {
    pagination: { cursor: result.cursor, hasMore: result.hasMore, limit: query.limit },
  });
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, (await withHolderNames([await service.findAsset(req.params.id!)]))[0]);
}

export async function create(req: Request, res: Response): Promise<void> {
  const asset = await service.createAsset(req.body as service.AssetInput);
  created(res, present(asset), `/api/v1/assets/${String(asset._id)}`);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { version, ...body } = req.body as service.AssetInput & { version?: number };
  ok(res, present(await service.updateAsset(req.params.id!, body, version)));
}

export async function transition(req: Request, res: Response): Promise<void> {
  const body = req.body as { to: string; comment?: string; fields?: Record<string, unknown> };
  ok(res, present(await service.transitionAsset(req.params.id!, body.to, body)));
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deleteAsset(req.params.id!);
  noContent(res);
}

export async function restore(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.restoreAsset(req.params.id!)));
}

export async function timeline(req: Request, res: Response): Promise<void> {
  // Confirms the asset is visible to this actor before returning its history.
  const asset = await service.findAsset(req.params.id!);

  const entries = await assetTimeline(String(asset._id), { limit: 100 });

  // Actors are USERS — the people who changed things — not the asset holders in
  // the people directory. The console had been looking them up among holders,
  // so nearly every entry read "by Unknown".
  const actors = await userDirectory().namesFor(
    [...new Set(entries.map((e) => e.actorId).filter((id): id is string => Boolean(id)))],
  );

  ok(
    res,
    entries.map((e) => ({
      id: String(e._id),
      type: e.type,
      occurredAt: e.occurredAt,
      summary: e.summary,
      changes: e.changes,
      actorId: e.actorId,
      actorName: e.actorId ? (actors.get(e.actorId)?.name ?? null) : null,
      actorType: e.actorType,
      comment: e.comment,
      relatedIds: e.relatedIds,
    })),
  );
}

/** The moves offered in the UI, filtered by this actor's permissions. */
export async function transitions(req: Request, res: Response): Promise<void> {
  const asset = await service.findAsset(req.params.id!);
  const type = await AssetTypeModel.findById(asset.assetTypeId).exec();

  ok(
    res,
    await availableTransitions({
      workflowId: type?.lifecycleWorkflowId,
      from: asset.lifecycleState,
    }),
  );
}

export async function summary(_req: Request, res: Response): Promise<void> {
  ok(res, { byState: await countByState() });
}
