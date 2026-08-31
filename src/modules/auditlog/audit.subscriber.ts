import type { EventSubscriber, StoredEvent } from '../../core/events/index.js';
import { getContext } from '../../core/context/index.js';
import { resolveEntitlements } from '../subscriptions/index.js';
import { logger } from '../../core/logging/index.js';
import { AuditLogModel } from './auditLog.model.js';

/**
 * Writes an audit record for every domain event.
 *
 * Subscribes to everything (`'*'`), because deciding what is audit-worthy at
 * emit time is how gaps appear. Filtering happens at read time instead, where
 * it is reversible.
 */
export const auditSubscriber: EventSubscriber = {
  name: 'audit',
  types: '*',

  async handle(event: StoredEvent): Promise<void> {
    await writeAuditRecord({
      action: event.type,
      entityType: event.subjectType,
      entityId: event.subjectId,
      changes: (event.changes ?? []).map((c) => ({ field: c.field, from: c.from, to: c.to })),
      metadata: { summary: event.summary, ...(event.relatedIds ?? {}) },
      actorId: event.actorId,
      actorType: event.actorType,
      requestId: event.requestId,
      occurredAt: event.occurredAt,
      sourceEventId: event.id,
    });
  },
};

export interface AuditRecordInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Array<{ field: string; from: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
  actorType?: string;
  actorIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  occurredAt?: Date;
  sourceEventId?: string | null;
}

/**
 * Also called directly for things that are not domain events — logins, denied
 * authorization attempts, exports. Those have no state change to hang an event
 * off, but they are exactly what an auditor asks about.
 */
export async function writeAuditRecord(input: AuditRecordInput): Promise<void> {
  const ctx = getContext();

  await AuditLogModel.create({
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    changes: input.changes ?? [],
    metadata: input.metadata ?? {},
    actorId: input.actorId ?? ctx?.userId ?? null,
    actorType: input.actorType ?? ctx?.actorType ?? 'system',
    actorIp: input.actorIp ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? ctx?.requestId ?? null,
    outcome: input.outcome ?? 'success',
    occurredAt: input.occurredAt ?? new Date(),
    expiresAt: await retentionDate(),
    sourceEventId: input.sourceEventId ?? null,
  });
}

/**
 * Retention comes from the tenant's plan and is stamped per document, because a
 * TTL index has one fixed expiry for every row in the collection.
 */
async function retentionDate(): Promise<Date | null> {
  try {
    const { entitlements } = await resolveEntitlements();
    const days = entitlements.auditRetentionDays ?? 90;
    return new Date(Date.now() + days * 86_400_000);
  } catch (err) {
    // Never lose an audit record because billing data is momentarily
    // unavailable. No expiry means it is kept until someone decides otherwise.
    logger.warn({ err }, 'Could not resolve audit retention — writing without an expiry');
    return null;
  }
}
