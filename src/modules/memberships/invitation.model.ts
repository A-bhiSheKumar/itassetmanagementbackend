import { defineModel } from '../../core/db/index.js';
import { Schema, type InferSchemaType } from 'mongoose';

const invitationSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    roleIds: { type: [String], required: true },

    /** Hashed — the plaintext exists only in the email that was sent. */
    tokenHash: { type: String, required: true },

    invitedBy: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

invitationSchema.index({ tokenHash: 1 }, { unique: true });

// One live invitation per email per tenant. Partial on "not yet resolved", so
// re-inviting someone who previously accepted and left still works.
invitationSchema.index(
  { tenantId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { acceptedAt: null, revokedAt: null, deletedAt: null },
  },
);

invitationSchema.index({ tenantId: 1, acceptedAt: 1, createdAt: -1 });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type Invitation = InferSchemaType<typeof invitationSchema>;

export const InvitationModel = defineModel('Invitation', invitationSchema);
