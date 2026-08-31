import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { flattenCustomFields, availableTransitions, AssetTypeModel } from '../catalog/index.js';
import { assetTimeline } from '../timeline/index.js';
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

  list(res, result.items.map(present), {
    pagination: { cursor: result.cursor, hasMore: result.hasMore, limit: query.limit },
  });
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.findAsset(req.params.id!)));
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

  ok(
    res,
    entries.map((e) => ({
      id: String(e._id),
      type: e.type,
      occurredAt: e.occurredAt,
      summary: e.summary,
      changes: e.changes,
      actorId: e.actorId,
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
