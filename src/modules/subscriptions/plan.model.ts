import { Schema, type InferSchemaType } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../core/db/index.js';

/**
 * A commercial plan.
 *
 * Entitlements are DATA, not code. There is no `if (plan === 'pro')` anywhere:
 * adding a plan, or granting one customer a one-off exception via
 * subscription.entitlementOverrides, never requires a deploy.
 *
 * `null` means unlimited.
 */
const planSchema = markSchemaGlobal(
  new Schema(
    {
      key: { type: String, required: true, lowercase: true },
      name: { type: String, required: true },
      description: { type: String, default: '' },

      entitlements: {
        /** Logins. NOT the number of people who can hold an asset (ADR-003). */
        seats: { type: Number, default: null },
        people: { type: Number, default: null },
        assets: { type: Number, default: null },
        storageBytes: { type: Number, default: null },
        customFields: { type: Number, default: null },
        customRoles: { type: Boolean, default: false },
        auditRetentionDays: { type: Number, default: 90 },
        apiAccess: { type: Boolean, default: false },
        webhooks: { type: Boolean, default: false },
        sso: { type: Boolean, default: false },
      },

      pricing: {
        monthly: { type: Number, default: 0 },
        annual: { type: Number, default: 0 },
        currency: { type: String, default: 'GBP' },
      },

      isPublic: { type: Boolean, default: true },
      sortOrder: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);

planSchema.index({ key: 1 }, { unique: true });
planSchema.index({ isPublic: 1, sortOrder: 1 });

export type Plan = InferSchemaType<typeof planSchema>;

/**
 * Declared explicitly rather than inferred from the schema.
 *
 * Mongoose types nested subdocuments as possibly-undefined, which is accurate
 * for an arbitrary path but wrong here — entitlements always exist, and every
 * consumer would otherwise need a null check that can never fire. `null` means
 * unlimited; `undefined` is not a valid state.
 */
export interface Entitlements {
  seats: number | null;
  people: number | null;
  assets: number | null;
  storageBytes: number | null;
  customFields: number | null;
  customRoles: boolean;
  auditRetentionDays: number;
  apiAccess: boolean;
  webhooks: boolean;
  sso: boolean;
}

export const PlanModel = defineModel('Plan', planSchema);

/** Seeded on first boot. Mirrors docs/01-product-scope.md §5. */
export const DEFAULT_PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'For small teams getting their estate under control.',
    entitlements: {
      seats: 5,
      people: 100,
      assets: 250,
      storageBytes: 1_073_741_824,
      customFields: 5,
      customRoles: false,
      auditRetentionDays: 90,
      apiAccess: false,
      webhooks: false,
      sso: false,
    },
    pricing: { monthly: 4900, annual: 49_000, currency: 'GBP' },
    sortOrder: 1,
  },
  {
    key: 'professional',
    name: 'Professional',
    entitlements: {
      seats: 25,
      people: 500,
      assets: 2_500,
      storageBytes: 10_737_418_240,
      customFields: 25,
      customRoles: false,
      auditRetentionDays: 365,
      apiAccess: false,
      webhooks: false,
      sso: false,
    },
    pricing: { monthly: 14_900, annual: 149_000, currency: 'GBP' },
    sortOrder: 2,
  },
  {
    key: 'business',
    name: 'Business',
    entitlements: {
      seats: 100,
      people: 5_000,
      assets: 25_000,
      storageBytes: 107_374_182_400,
      customFields: null,
      customRoles: true,
      auditRetentionDays: 1_095,
      apiAccess: true,
      webhooks: true,
      sso: false,
    },
    pricing: { monthly: 39_900, annual: 399_000, currency: 'GBP' },
    sortOrder: 3,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    entitlements: {
      seats: null,
      people: null,
      assets: null,
      storageBytes: null,
      customFields: null,
      customRoles: true,
      auditRetentionDays: 2_555,
      apiAccess: true,
      webhooks: true,
      sso: true,
    },
    pricing: { monthly: 0, annual: 0, currency: 'GBP' },
    isPublic: false,
    sortOrder: 4,
  },
] as const;
