import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../core/db/index.js';

/**
 * A User is a LOGIN, not an employee (ADR-003).
 *
 * Deliberately thin: no tenant data lives here. Everything tenant-specific —
 * role, department, scope — belongs to Membership. That split is what lets one
 * person belong to several customer organisations, and what keeps seat billing
 * honest (we charge for logins, not for people who hold a laptop).
 *
 * GLOBAL model: not tenant-scoped. A user exists before any tenant does.
 */
const userSchema = markSchemaGlobal(
  new Schema(
    {
      email: { type: String, required: true, trim: true, lowercase: true },
      emailVerifiedAt: { type: Date, default: null },

      passwordHash: { type: String, required: true, select: false },

      name: { type: String, required: true, trim: true },
      avatarUrl: { type: String, default: null },

      status: {
        type: String,
        enum: ['active', 'suspended', 'deleted'],
        default: 'active',
        index: true,
      },

      /**
       * Bumped to revoke every session everywhere at once — password change,
       * suspected compromise, account suspension. Cheaper and more reliable
       * than maintaining a token blocklist.
       */
      tokenVersion: { type: Number, default: 0 },

      defaultTenantId: { type: String, default: null },

      lastLoginAt: { type: Date, default: null },
      failedLoginCount: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);

/**
 * Case-insensitive uniqueness via collation, not by lowercasing in application
 * code. Relying on the setter means one code path that forgets it creates a
 * duplicate account for the same person.
 */
userSchema.index({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
userSchema.index({ tokenVersion: 1 });

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;

export const UserModel = defineModel('User', userSchema);
