import { defineModel } from '../../core/db/index.js';
import { Schema, type InferSchemaType } from 'mongoose';

const subscriptionSchema = new Schema(
  {
    planId: { type: String, required: true },
    planKey: { type: String, required: true },

    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'cancelled', 'expired'],
      default: 'trialing',
    },

    seatsPurchased: { type: Number, default: 5 },

    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },

    /**
     * Reads stay open after expiry; only writes are blocked
     * (docs/06-edge-cases.md #20). Never hold a customer's data hostage.
     */
    graceEndsAt: { type: Date, default: null },

    /**
     * Per-customer exceptions without a new plan or a deploy — "give Acme 500
     * extra assets while they migrate".
     */
    entitlementOverrides: { type: Schema.Types.Mixed, default: {} },

    /** 'manual' for the first cohort; 'stripe' later. The abstraction is here now. */
    provider: { type: String, enum: ['manual', 'stripe'], default: 'manual' },
    providerRefs: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

/**
 * Named explicitly.
 *
 * The tenant-scope plugin already declares `tenantId` as indexed, which
 * auto-generates the name `tenantId_1`. A second index on the same key with
 * different options collides on that name, and MongoDB refuses it — so this
 * unique constraint silently never existed and a tenant could have ended up
 * with two of these. Surfaced by the index-error logging in core/db.
 */
subscriptionSchema.index({ tenantId: 1 }, { unique: true, name: 'tenantId_unique' });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export type Subscription = InferSchemaType<typeof subscriptionSchema>;

export const SubscriptionModel = defineModel('Subscription', subscriptionSchema);
