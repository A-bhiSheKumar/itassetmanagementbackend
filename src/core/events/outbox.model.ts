import { Schema, type Model, type InferSchemaType } from 'mongoose';
import { defineModel, type Scoped } from '../db/index.js';
import { EVENT_TYPES } from './types.js';

/**
 * The transactional outbox.
 *
 * An event row is written in the SAME transaction as the state change it
 * describes. That is the whole point: state and history cannot diverge, because
 * either both commit or neither does. Delivery to subscribers happens after the
 * commit, so a failing webhook can never fail a user's request.
 */
const outboxEventSchema = new Schema(
  {
    type: { type: String, required: true, enum: EVENT_TYPES },

    subjectId: { type: String, required: true },
    subjectType: { type: String, required: true, enum: ['asset', 'person', 'assignment'] },

    summary: { type: String, required: true },
    changes: {
      type: [{ field: String, label: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed, _id: false }],
      default: [],
    },
    relatedIds: { type: Schema.Types.Mixed, default: {} },
    comment: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },

    /** Actor REFERENCE, never a copied name — see ADR-013. */
    actorId: { type: String, default: null },
    actorType: {
      type: String,
      enum: ['user', 'system', 'job', 'integration', 'import'],
      default: 'user',
    },
    requestId: { type: String, default: null },

    occurredAt: { type: Date, required: true, default: () => new Date() },

    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: () => new Date() },
    lastError: { type: String, default: null },
    /** Names of subscribers that have already handled this — makes retries safe. */
    completedSubscribers: { type: [String], default: [] },
  },
  { timestamps: true },
);

// The dispatcher's only query. Kept tight because it runs constantly.
outboxEventSchema.index({ status: 1, availableAt: 1 });
outboxEventSchema.index({ tenantId: 1, occurredAt: -1 });
outboxEventSchema.index(
  { status: 1, occurredAt: 1 },
  { partialFilterExpression: { status: 'failed' } },
);

// Delivered events are disposable. TTL avoids a growing table nobody prunes.
outboxEventSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: 30 * 86_400, partialFilterExpression: { status: 'done' } },
);

export type OutboxEvent = Scoped<InferSchemaType<typeof outboxEventSchema>>;

// Cast so the plugin-added fields (tenantId in particular) are visible to the
// dispatcher, which reads them on every event.
export const OutboxEventModel = defineModel(
  'OutboxEvent',
  outboxEventSchema,
) as unknown as Model<OutboxEvent>;
