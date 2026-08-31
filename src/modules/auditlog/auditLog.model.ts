import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * Append-only audit trail.
 *
 * No update or delete route exists for this collection at ANY role, Owner
 * included. That is the point: an administrator must not be able to erase
 * evidence of their own action.
 *
 * Retention is per plan, applied through a TTL index on a per-document
 * `expiresAt` set at write time — MongoDB TTL is fixed per index, so the
 * varying part has to live in the document.
 */
const auditLogSchema = new Schema(
  {
    occurredAt: { type: Date, required: true, default: () => new Date() },

    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },

    actorId: { type: String, default: null },
    actorType: { type: String, default: 'user' },
    actorIp: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },

    changes: {
      type: [{ field: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed, _id: false }],
      default: [],
    },
    metadata: { type: Schema.Types.Mixed, default: {} },

    outcome: { type: String, enum: ['success', 'denied', 'error'], default: 'success' },

    /** Set from the tenant's plan retention. Drives the TTL below. */
    expiresAt: { type: Date, default: null },

    sourceEventId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ tenantId: 1, occurredAt: -1 });
auditLogSchema.index({ tenantId: 1, entityType: 1, entityId: 1, occurredAt: -1 });
auditLogSchema.index({ tenantId: 1, actorId: 1, occurredAt: -1 });
auditLogSchema.index({ tenantId: 1, action: 1, occurredAt: -1 });

// Denied attempts get their own index: a burst of them is the clearest
// available signal of an attack in progress.
auditLogSchema.index(
  { tenantId: 1, outcome: 1, occurredAt: -1 },
  { partialFilterExpression: { outcome: 'denied' } },
);

// Prefixed with tenantId like every other index: a tenant-scoped query filters
// on tenantId first, so an index that does not lead with it can never serve one.
auditLogSchema.index({ tenantId: 1, sourceEventId: 1 }, { sparse: true });
auditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuditLog = Scoped<InferSchemaType<typeof auditLogSchema>>;

export const AuditLogModel = defineModel('AuditLog', auditLogSchema) as unknown as Model<AuditLog>;
