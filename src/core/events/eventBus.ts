import type { ClientSession } from 'mongoose';
import { ulid } from 'ulid';
import { getContext, runAsSystem, withoutTenantScope } from '../context/index.js';
import { logger } from '../logging/index.js';
import { OutboxEventModel } from './outbox.model.js';
import type { DomainEvent } from './types.js';

/**
 * The event spine (ADR-007).
 *
 * Services call `emit(event, session)` inside their transaction. Subscribers
 * are registered once at startup by the composition root — core never imports
 * a module, so the wiring lives in src/subscribers.ts.
 */

export interface EventSubscriber {
  name: string;
  types: readonly string[] | '*';
  handle(event: StoredEvent): Promise<void>;
}

export interface StoredEvent extends DomainEvent {
  id: string;
  tenantId: string;
  actorId: string | null;
  actorType: string;
  requestId: string | null;
  occurredAt: Date;
}

const subscribers: EventSubscriber[] = [];

export function registerSubscriber(subscriber: EventSubscriber): void {
  if (subscribers.some((s) => s.name === subscriber.name)) return;
  subscribers.push(subscriber);
}

export function clearSubscribers(): void {
  subscribers.length = 0;
}

/**
 * Writes an event inside the caller's transaction.
 *
 * The session argument is not optional by accident: an event committed
 * separately from its state change is exactly the divergence this design
 * exists to prevent.
 */
export async function emit(event: DomainEvent, session: ClientSession): Promise<void> {
  const ctx = getContext();

  const [row] = await OutboxEventModel.create(
    [
      {
        ...event,
        actorId: ctx?.userId ?? null,
        actorType: ctx?.actorType ?? 'system',
        requestId: ctx?.requestId ?? null,
        occurredAt: new Date(),
      },
    ],
    { session },
  );

  // Remembered so the post-commit flush can deliver exactly this request's
  // events rather than scanning the global queue.
  if (ctx && row) (ctx.pendingEventIds ??= []).push(String(row._id));
}

/**
 * Delivers THIS REQUEST's events, immediately after its commit.
 *
 * Scoped to the ids the request emitted, not the global queue. Draining the
 * whole queue here would make every write's latency depend on the backlog —
 * a busy tenant would slow down a quiet one, and a large import would make
 * each row progressively slower.
 *
 * Delivering inline is still worth it: the request's own timeline and audit
 * entries exist by the time it responds, which makes the API predictable and
 * the tests deterministic. Anything that fails here is left pending for the
 * worker.
 *
 * Never throws into the caller: a broken subscriber must not fail a request
 * that has already committed.
 */
export async function flushOutbox(): Promise<number> {
  const ctx = getContext();
  if (!ctx) return 0;

  const ids = ctx.pendingEventIds;
  if (!ids?.length) return 0;

  // Cleared first: a retry inside deliver() must not re-enqueue them here.
  ctx.pendingEventIds = [];

  try {
    const rows = await OutboxEventModel.find({ _id: { $in: ids } }).exec();
    return await deliver(rows);
  } catch (err) {
    logger.error({ err }, 'Outbox flush failed — the worker will retry');
    return 0;
  }
}

export async function dispatchPending(limit = 50): Promise<number> {
  const now = new Date();

  /**
   * The scan is deliberately cross-tenant: the worker drains events for every
   * customer, and it has no request context at all. Each event is then handled
   * under ITS OWN tenant (see runAsSystem below), so subscribers are fully
   * scoped — only the queue read spans tenants.
   */
  const pending = await runAsSystem({ requestId: ulid() }, () =>
    withoutTenantScope('outbox dispatcher drains every tenant', () =>
      OutboxEventModel.find({
        status: { $in: ['pending', 'failed'] },
        availableAt: { $lte: now },
      })
        .sort({ occurredAt: 1 })
        .limit(limit)
        .exec(),
    ),
  );

  return deliver(pending);
}

/** Shared delivery loop for both the inline flush and the worker's drain. */
async function deliver(pending: Array<InstanceType<typeof OutboxEventModel>>): Promise<number> {
  let delivered = 0;

  for (const row of pending) {
    const stored: StoredEvent = {
      id: String(row._id),
      tenantId: row.tenantId,
      type: row.type as StoredEvent['type'],
      subjectId: row.subjectId,
      subjectType: row.subjectType as StoredEvent['subjectType'],
      summary: row.summary,
      changes: row.changes as StoredEvent['changes'],
      relatedIds: (row.relatedIds ?? {}) as Record<string, string | null>,
      comment: row.comment ?? undefined,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      actorId: row.actorId ?? null,
      actorType: row.actorType ?? 'system',
      requestId: row.requestId ?? null,
      occurredAt: row.occurredAt,
    };

    const applicable = subscribers.filter(
      (s) => s.types === '*' || s.types.includes(row.type),
    );

    const failures: string[] = [];

    for (const subscriber of applicable) {
      // Idempotency: a redelivered event must not duplicate a timeline entry.
      if (row.completedSubscribers.includes(subscriber.name)) continue;

      try {
        // Subscribers run under the EVENT's tenant, not the caller's — the
        // worker has no request context at all.
        await runAsSystem({ requestId: row.requestId ?? row._id.toString(), tenantId: row.tenantId }, () =>
          subscriber.handle(stored),
        );
        row.completedSubscribers.push(subscriber.name);
      } catch (err) {
        failures.push(subscriber.name);
        logger.error({ err, subscriber: subscriber.name, eventId: stored.id }, 'Subscriber failed');
      }
    }

    row.attempts += 1;

    if (failures.length === 0) {
      row.status = 'done';
      row.lastError = null;
      delivered += 1;
    } else if (row.attempts >= 5) {
      // Dead letter. Someone has to look at it; retrying forever hides the bug.
      row.status = 'failed';
      row.lastError = `Dead-lettered after ${row.attempts} attempts: ${failures.join(', ')}`;
      logger.error({ eventId: stored.id, failures }, 'Outbox event dead-lettered');
    } else {
      row.status = 'pending';
      row.lastError = `Failed: ${failures.join(', ')}`;
      row.availableAt = new Date(Date.now() + 2 ** row.attempts * 1000);
    }

    await runAsSystem({ requestId: row.requestId ?? 'outbox', tenantId: row.tenantId }, () =>
      row.save(),
    );
  }

  return delivered;
}
