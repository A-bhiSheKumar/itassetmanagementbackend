import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../core/db/index.js';

/**
 * A customer organisation.
 *
 * GLOBAL model: the Tenant document defines the tenant, so it cannot be scoped
 * by one. Everything else in the system is.
 */
const tenantSchema = markSchemaGlobal(
  new Schema(
    {
      name: { type: String, required: true, trim: true },
      slug: { type: String, required: true, lowercase: true, trim: true },

      status: {
        type: String,
        enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'deleted'],
        default: 'trialing',
        index: true,
      },

      ownerUserId: { type: String, required: true },

      settings: {
        /**
         * Every date boundary is computed in this zone. "Warranty expires today"
         * must give a Sydney tenant and a Los Angeles tenant different, correct
         * answers (docs/06-edge-cases.md #45).
         */
        timezone: { type: String, default: 'Europe/London' },
        locale: { type: String, default: 'en-GB' },
        currency: { type: String, default: 'GBP' },
        assetTagPrefix: { type: String, default: 'AST' },

        /**
         * Which kind of estate this organisation tracks. Decides the starter
         * catalogue at signup and nothing else afterwards — it is a label, not
         * a code path (see catalog/industry.ts).
         */
        industry: { type: String, default: 'it' },

        /**
         * What the product calls things here. An organisation tracking vans
         * should read "vehicle" everywhere, not "asset"; the alternative is a
         * product that always sounds like it was built for somebody else.
         */
        vocabulary: {
          asset: { type: String, default: 'asset' },
          assets: { type: String, default: 'assets' },
          person: { type: String, default: 'person' },
          people: { type: String, default: 'people' },
        },

        /**
         * Sections switched off for this organisation. Presentation only —
         * permissions still decide access — so turning one off never orphans
         * data that is already there.
         */
        modules: {
          maintenance: { type: Boolean, default: true },
          licences: { type: Boolean, default: true },
          vendors: { type: Boolean, default: true },
        },
        /** Enterprise tenants can refuse support impersonation entirely. */
        allowImpersonation: { type: Boolean, default: true },
      },

      trialEndsAt: { type: Date, default: null },
      suspendedAt: { type: Date, default: null },
      suspendedReason: { type: String, default: null },

      /** Set on a deletion request; a purge job acts after the grace window. */
      deletionScheduledAt: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);

tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ status: 1, createdAt: -1 });
tenantSchema.index({ deletionScheduledAt: 1 }, { sparse: true });

export type Tenant = InferSchemaType<typeof tenantSchema>;
export type TenantDocument = HydratedDocument<Tenant>;

export const TenantModel = defineModel('Tenant', tenantSchema);
