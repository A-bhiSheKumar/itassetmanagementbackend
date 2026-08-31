import { defineModel } from '../../core/db/index.js';
import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * The join between a User and a Tenant (ADR-003).
 *
 * This is where a person's role, scope and status within one organisation live.
 * It is what makes "the same email belongs to four customer organisations" a
 * normal case rather than a schema problem.
 */
const membershipSchema = new Schema(
  {
    userId: { type: String, required: true },

    /** Links a login to the Person record that can hold assets (M2). */
    personId: { type: String, default: null },

    roleIds: { type: [String], required: true, default: [] },

    /**
     * Department/location scoping for Manager-type roles. Applied as an extra
     * filter in list queries AND checked in record-level policies, so a scoped
     * user's list and their detail access can never disagree.
     */
    scope: {
      type: {
        type: String,
        enum: ['all', 'department', 'location'],
        default: 'all',
      },
      departmentIds: { type: [String], default: [] },
      locationIds: { type: [String], default: [] },
    },

    status: {
      type: String,
      enum: ['invited', 'active', 'suspended'],
      default: 'active',
    },

    /**
     * Incremented on any role or scope change. Invalidates the Redis permission
     * cache and every outstanding access token carrying an older value, so a
     * revoked permission cannot outlive one request.
     */
    permVersion: { type: Number, default: 0 },

    invitedBy: { type: String, default: null },
    joinedAt: { type: Date, default: null },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One membership per user per tenant. Partial so a removed member can rejoin.
membershipSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// "Which organisations am I in?" — the login tenant picker. Deliberately NOT
// prefixed with tenantId: this is the one query that spans tenants by design,
// and it runs before a tenant has been chosen.
membershipSchema.index({ userId: 1, status: 1 });

membershipSchema.index({ tenantId: 1, status: 1, lastActiveAt: -1 });

// "Who are the Owners?" — powers the last-owner guard, which runs on every
// role change, removal and deactivation.
membershipSchema.index({ tenantId: 1, roleIds: 1 });

export type Membership = InferSchemaType<typeof membershipSchema>;
export type MembershipDocument = HydratedDocument<Membership>;

export const MembershipModel = defineModel('Membership', membershipSchema);
