import type { Request, Response } from 'express';
import { list } from '../../core/http/index.js';
import { AuditLogModel } from './auditLog.model.js';

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    limit: number;
    entityType?: string;
    entityId?: string;
    action?: string;
    actorId?: string;
    outcome?: string;
  };

  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) filter.action = query.action;
  if (query.actorId) filter.actorId = query.actorId;
  if (query.outcome) filter.outcome = query.outcome;

  const rows = await AuditLogModel.find(filter)
    .sort({ occurredAt: -1 })
    .limit(query.limit)
    .lean();

  list(
    res,
    rows.map((r) => ({
      id: String(r._id),
      occurredAt: r.occurredAt,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      // A reference, never a name — see ADR-013.
      actorId: r.actorId,
      actorType: r.actorType,
      outcome: r.outcome,
      changes: r.changes,
      metadata: r.metadata,
      requestId: r.requestId,
    })),
    { pagination: { cursor: null, hasMore: rows.length === query.limit, limit: query.limit } },
  );
}
