import type { Request, Response } from 'express';
import { ok, created, list } from '../../core/http/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { AssetModel } from '../assets/index.js';
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

  list(res, rows.map(present), {
    pagination: { cursor: null, hasMore: rows.length === query.limit, limit: query.limit },
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
