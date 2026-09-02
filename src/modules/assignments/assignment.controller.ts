import type { Request, Response } from 'express';
import { ok, created, list } from '../../core/http/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { AssetModel } from '../assets/index.js';
import { PersonModel, LocationModel } from '../people/index.js';
import { isProduction } from '../../config/index.js';
import type { AssignmentDocument } from './assignment.model.js';
import { AssignmentModel } from './assignment.model.js';
import * as service from './assignment.service.js';

function present(assignment: AssignmentDocument) {
  return {
    id: String(assignment._id),
    assetId: assignment.assetId,
    assigneeType: assignment.assigneeType,
    assigneeId: assignment.assigneeId,
    status: assignment.status,
    assignedBy: assignment.assignedBy,
    assignedAt: assignment.assignedAt,
    dueAt: assignment.dueAt,
    returnedAt: assignment.returnedAt,
    conditionOut: assignment.conditionOut,
    conditionIn: assignment.conditionIn,
    acknowledgementRequired: assignment.acknowledgement?.requiredAt != null,
    acknowledgedAt: assignment.acknowledgement?.acknowledgedAt ?? null,
    notes: assignment.notes,
    previousAssignmentId: assignment.previousAssignmentId,
  };
}

export async function assign(req: Request, res: Response): Promise<void> {
  const body = req.body as service.AssignInput;
  const assignment = await service.assignAsset({ ...body, assetId: req.params.id! });

  created(res, present(assignment));
}

export async function unassign(req: Request, res: Response): Promise<void> {
  const body = req.body as service.ReturnInput;
  ok(res, present(await service.returnAsset({ ...body, assetId: req.params.id! })));
}

export async function transfer(req: Request, res: Response): Promise<void> {
  const body = req.body as { toAssigneeId: string; notes?: string; condition?: string };
  ok(res, present(await service.transferAsset({ ...body, assetId: req.params.id! })));
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { limit: number; assigneeId?: string; status?: string };

  const filter: Record<string, unknown> = {};
  if (query.assigneeId) filter.assigneeId = query.assigneeId;
  if (query.status) filter.status = query.status;

  const rows = await AssignmentModel.find(filter)
    .sort({ assignedAt: -1 })
    .limit(query.limit)
    .exec();

  list(res, await withNames(rows), {
    pagination: { cursor: null, hasMore: rows.length === query.limit, limit: query.limit },
  });
}

/**
 * Attaches the asset and assignee names a list has to show.
 *
 * `present` returns ids because that is the honest shape of one record. A LIST
 * of ids is not a screen anyone can use, and the two ways to avoid this are
 * both worse: resolving client-side means shipping the asset collection to the
 * browser, and denormalising the names onto the assignment means every rename
 * needs a backfill.
 *
 * Three batched queries regardless of page size — never one per row.
 */
async function withNames(rows: AssignmentDocument[]) {
  const byType = (type: string): string[] => [
    ...new Set(rows.filter((r) => r.assigneeType === type).map((r) => r.assigneeId)),
  ];

  const assetIds = [...new Set(rows.map((r) => r.assetId))];
  // An asset can be assigned to another asset — a dock to a laptop — so the
  // asset lookup covers both the subject and that kind of assignee.
  const assigneeAssetIds = byType('asset');

  const [assets, people, locations] = await Promise.all([
    AssetModel.find({ _id: { $in: [...new Set([...assetIds, ...assigneeAssetIds])] } })
      .select('name assetTag')
      .lean(),
    PersonModel.find({ _id: { $in: byType('person') } })
      // Composed here rather than read as a virtual: `.lean()` returns plain
      // documents and virtuals do not survive it.
      .select('firstName lastName')
      .lean(),
    LocationModel.find({ _id: { $in: byType('location') } })
      .select('name')
      .lean(),
  ]);

  const assetNames = new Map(assets.map((a) => [String(a._id), { name: a.name, tag: a.assetTag }]));
  const personNames = new Map(people.map((p) => [String(p._id), `${p.firstName} ${p.lastName}`]));
  const locationNames = new Map(locations.map((l) => [String(l._id), l.name]));

  return rows.map((row) => {
    const asset = assetNames.get(row.assetId);

    const assigneeName =
      row.assigneeType === 'person'
        ? personNames.get(row.assigneeId)
        : row.assigneeType === 'location'
          ? locationNames.get(row.assigneeId)
          : assetNames.get(row.assigneeId)?.name;

    return {
      ...present(row),
      assetName: asset?.name ?? null,
      assetTag: asset?.tag ?? null,
      // Null rather than a placeholder: a deleted assignee is a real state and
      // the client decides how to word it, in its own language.
      assigneeName: assigneeName ?? null,
    };
  });
}

export async function acknowledge(req: Request, res: Response): Promise<void> {
  const { token } = req.body as { token: string };
  ok(res, present(await service.acknowledgeAssignment(token)));
}

/** Chain of custody for one asset. */
export async function history(req: Request, res: Response): Promise<void> {
  const assetId = req.params.id!;

  // Resolve the asset first. Querying assignments directly is tenant-scoped so
  // it cannot leak, but it answers a foreign id with an empty 200 — breaking
  // the rule that a record you cannot see is indistinguishable from one that
  // does not exist (ADR-015).
  const asset = await AssetModel.findById(assetId).select('_id').lean();
  if (!asset) throw new NotFoundError('Asset');

  const rows = await service.assignmentHistory(assetId);
  ok(res, rows.map(present));
}

/**
 * Everything a person holds.
 *
 * The offboarding screen's core query, and the answer to "what do we need back
 * from this leaver?".
 */
export async function heldBy(req: Request, res: Response): Promise<void> {
  const rows = await service.activeAssignmentsFor(req.params.id!);
  ok(res, rows.map(present));
}

// Development only: the acknowledgement email lands in M4. Until then the
// token has to reach the test somehow, and it must never leak in production.
export function includeTokenInDev(token: string | null): Record<string, string> {
  return !isProduction && token ? { acknowledgementToken: token } : {};
}
