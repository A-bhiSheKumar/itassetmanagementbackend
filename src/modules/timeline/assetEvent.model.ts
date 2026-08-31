import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * The user-facing history of one asset.
 *
 * Distinct from the audit log (ADR-012): different consumer, different
 * retention, different content. This is the story a user reads on the asset
 * page; the audit log is evidence for compliance and includes logins,
 * permission changes and exports.
 */
const assetEventSchema = new Schema(
  {
    assetId: { type: String, required: true },
    type: { type: String, required: true },

    occurredAt: { type: Date, required: true },
    summary: { type: String, required: true },

    changes: {
      type: [{ field: String, label: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed, _id: false }],
      default: [],
    },

    /**
     * Actor REFERENCE, never a copied name (ADR-013). Display names resolve at
     * read time, so erasing a person leaves history intact and renders
     * "Deleted user" rather than destroying the record.
     */
    actorId: { type: String, default: null },
    actorType: { type: String, default: 'user' },

    relatedIds: { type: Schema.Types.Mixed, default: {} },
    comment: { type: String, default: null },

    /** Outbox event id. Unique, so redelivery cannot duplicate an entry. */
    sourceEventId: { type: String, required: true },
  },
  { timestamps: true },
);

// The asset detail timeline.
assetEventSchema.index({ tenantId: 1, assetId: 1, occurredAt: -1 });
// The tenant-wide activity feed on the dashboard.
assetEventSchema.index({ tenantId: 1, occurredAt: -1 });
assetEventSchema.index({ tenantId: 1, actorId: 1, occurredAt: -1 });
assetEventSchema.index({ tenantId: 1, type: 1, occurredAt: -1 });

/**
 * Idempotency for the projector: a redelivered event cannot create a second
 * timeline entry.
 *
 * Prefixed with tenantId like every other unique index. The outbox id is
 * globally unique anyway, so the prefix adds no constraint — but the rule that
 * every unique index leads with tenantId is worth keeping absolute, and an
 * exemption should be reserved for values genuinely looked up before a tenant
 * is known.
 */
assetEventSchema.index({ tenantId: 1, sourceEventId: 1 }, { unique: true });

export type AssetEvent = Scoped<InferSchemaType<typeof assetEventSchema>>;

export const AssetEventModel = defineModel(
  'AssetEvent',
  assetEventSchema,
) as unknown as Model<AssetEvent>;
