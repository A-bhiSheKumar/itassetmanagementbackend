import type { Request, Response } from 'express';
import { ok, created, list, noContent } from '../../core/http/index.js';
import { AssetModel } from '../assets/index.js';
import { vendorNames } from '../vendors/index.js';
import type { MaintenanceDocument } from './maintenance.model.js';
import * as service from './maintenance.service.js';

function present(r: MaintenanceDocument) {
  return {
    id: String(r._id),
    assetId: r.assetId,
    vendorId: r.vendorId,
    type: r.type,
    title: r.title,
    description: r.description,
    status: r.status,
    scheduledFor: r.scheduledFor,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    cost: r.cost,
    performedBy: r.performedBy,
    outcome: r.outcome,
    recurrenceMonths: r.recurrenceMonths,
    previousRecordId: r.previousRecordId,
    nextRecordId: r.nextRecordId,
    assetMovedToMaintenance: r.assetStateBefore !== null,
    createdAt: r.createdAt,
  };
}

/** Named on the way out, like assignments: a list of ids is not a work queue. */
async function withNames(rows: MaintenanceDocument[]) {
  const [assets, vendors] = await Promise.all([
    AssetModel.find({ _id: { $in: [...new Set(rows.map((r) => r.assetId))] } })
      .setOptions({ withDeleted: true })
      .select('name assetTag')
      .lean(),
    vendorNames(rows.map((r) => r.vendorId)),
  ]);
  const byId = new Map(assets.map((a) => [String(a._id), a]));

  return rows.map((r) => ({
    ...present(r),
    assetName: byId.get(r.assetId)?.name ?? null,
    assetTag: byId.get(r.assetId)?.assetTag ?? null,
    vendorName: r.vendorId ? (vendors.get(r.vendorId) ?? null) : null,
  }));
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as Parameters<typeof service.listMaintenance>[0];
  const page = await service.listMaintenance(query);
  list(res, await withNames(page.items), { pagination: { cursor: page.cursor, hasMore: page.hasMore, limit: query.limit } });
}

export async function show(req: Request, res: Response): Promise<void> {
  const [row] = await withNames([await service.findMaintenance(req.params.id!)]);
  ok(res, row);
}

export async function create(req: Request, res: Response): Promise<void> {
  const doc = await service.createMaintenance(req.body);
  const [row] = await withNames([doc]);
  created(res, row, `/api/v1/maintenance/${String(doc._id)}`);
}

export async function update(req: Request, res: Response): Promise<void> {
  const [row] = await withNames([await service.updateMaintenance(req.params.id!, req.body)]);
  ok(res, row);
}

export async function start(req: Request, res: Response): Promise<void> {
  const [row] = await withNames([await service.startMaintenance(req.params.id!, req.body)]);
  ok(res, row);
}

export async function complete(req: Request, res: Response): Promise<void> {
  const result = await service.completeMaintenance(req.params.id!, req.body);
  const [row] = await withNames([result.record]);
  ok(res, { ...row, next: result.next ? present(result.next) : null, assetWarning: result.assetWarning });
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const [row] = await withNames([await service.cancelMaintenance(req.params.id!)]);
  ok(res, row);
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deleteMaintenance(req.params.id!);
  noContent(res);
}

export async function costs(req: Request, res: Response): Promise<void> {
  ok(res, await service.maintenanceCosts(req.query as { assetId?: string; vendorId?: string }));
}
