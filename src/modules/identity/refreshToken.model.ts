import { Schema, type InferSchemaType } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../core/db/index.js';

/**
 * Refresh tokens, with rotation and reuse detection.
 *
 * Tokens belong to a FAMILY. Each refresh rotates: the presented token is
 * marked used and a new one issued into the same family. If a token that has
 * already been rotated is presented again, the only explanations are a stolen
 * token or a replayed one — so the entire family is revoked and a security event
 * raised. Without families, a stolen token is usable until it expires and we
 * never find out.
 *
 * GLOBAL model: a refresh token belongs to a user, before any tenant is chosen.
 */
const refreshTokenSchema = markSchemaGlobal(
  new Schema(
    {
      userId: { type: String, required: true },
      familyId: { type: String, required: true },

      /** SHA-256. A database dump must not yield working credentials. */
      tokenHash: { type: String, required: true },

      expiresAt: { type: Date, required: true },
      rotatedAt: { type: Date, default: null },
      revokedAt: { type: Date, default: null },
      revokedReason: {
        type: String,
        enum: ['logout', 'rotation', 'reuse_detected', 'password_change', 'admin', null],
        default: null,
      },

      /** Shown in the user's session list, and useful when triaging a breach. */
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });

// Self-cleaning: expired tokens are worthless and there is no reason to keep
// them. TTL removes them without a scheduled job.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshToken = InferSchemaType<typeof refreshTokenSchema>;

export const RefreshTokenModel = defineModel('RefreshToken', refreshTokenSchema);
