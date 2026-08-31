import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

export const NOTIFICATION_TYPES = [
  'asset.assigned',
  'asset.acknowledgement_requested',
  'warranty.expiring',
  'maintenance.due',
  'offboarding.outstanding',
  'import.completed',
  'import.failed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    /** A Membership id — only people who can sign in have an inbox. */
    recipientId: { type: String, required: true },

    type: { type: String, required: true, enum: NOTIFICATION_TYPES },
    title: { type: String, required: true },
    body: { type: String, default: '' },

    entityRef: {
      type: { type: String, default: null },
      id: { type: String, default: null },
    },
    actionUrl: { type: String, default: null },

    readAt: { type: Date, default: null },

    channels: { type: [String], default: ['in_app'] },
    deliveredAt: { type: Date, default: null },

    /**
     * Deduplication key. A nightly warranty scan runs every night; without this
     * a customer gets the same "expiring in 30 days" notice thirty times.
     */
    dedupeKey: { type: String, default: null },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The inbox, and the unread badge. ESR: equality on tenant/recipient/read,
// then the sort key.
notificationSchema.index({ tenantId: 1, recipientId: 1, readAt: 1, createdAt: -1 });

// One notification per recipient per subject per period.
notificationSchema.index(
  { tenantId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Notification = Scoped<InferSchemaType<typeof notificationSchema>>;

export const NotificationModel = defineModel(
  'Notification',
  notificationSchema,
) as unknown as Model<Notification>;
