import type { Request, Response } from 'express';
import { list } from '../../core/http/index.js';
import { AuditLogModel } from './auditLog.model.js';
import { UserModel } from '../identity/index.js';

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

  /*
   * Actor names, resolved at read time.
   *
   * ADR-013 is explicit that the row stores a REFERENCE and never a copied
   * name — a name copied into an audit row is a name that goes stale and
   * cannot be redacted. Resolving it on the way out keeps both properties: the
   * log stays a set of references, and the screen still says who.
   *
   * A deleted user resolves to null, and the client says so. That is the
   * correct answer for an append-only log that outlives its actors.
   */
  const actors = await UserModel.find({ _id: { $in: [...new Set(rows.map((r) => r.actorId))] } })
    .select('name')
    .lean();

  const actorNames = new Map(actors.map((u) => [String(u._id), u.name]));

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
      actorName: actorNames.get(r.actorId as string) ?? null,
      actorType: r.actorType,
      outcome: r.outcome,
      changes: r.changes,
      metadata: r.metadata,
      requestId: r.requestId,
    })),
    { pagination: { cursor: null, hasMore: rows.length === query.limit, limit: query.limit } },
  );
}
