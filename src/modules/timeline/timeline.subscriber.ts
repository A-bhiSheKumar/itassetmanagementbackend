import type { EventSubscriber, StoredEvent } from '../../core/events/index.js';
import { AssetEventModel } from './assetEvent.model.js';

/**
 * Projects domain events into the user-facing asset timeline.
 *
 * Idempotent on `sourceEventId`, which carries a unique index — so a redelivered
 * event cannot duplicate a timeline entry. Retries are therefore free, which is
 * what lets the dispatcher retry aggressively.
 */
export const timelineSubscriber: EventSubscriber = {
  name: 'timeline',
  types: [
    'asset.created',
    'asset.updated',
    'asset.deleted',
    'asset.restored',
    'asset.assigned',
    'asset.returned',
    'asset.transferred',
    'asset.transitioned',
    'asset.acknowledged',
  ],

  async handle(event: StoredEvent): Promise<void> {
    if (event.subjectType !== 'asset') return;

    try {
      await AssetEventModel.create({
        assetId: event.subjectId,
        type: event.type,
        occurredAt: event.occurredAt,
        summary: event.summary,
        changes: event.changes ?? [],
        actorId: event.actorId,
        actorType: event.actorType,
        relatedIds: event.relatedIds ?? {},
        comment: event.comment ?? null,
        sourceEventId: event.id,
      });
    } catch (err) {
      // A duplicate means this event was already projected. That is success,
      // not failure — treating it as an error would dead-letter a delivered
      // event and hide real problems behind noise.
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }
  },
};
