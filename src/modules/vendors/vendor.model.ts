import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

/**
 * A company the organisation buys from, or pays to look after things.
 *
 * One record for the supplier who sold the laptop, the repair shop that fixes
 * it and the publisher whose licence runs on it — which is what makes "what do
 * we have from Dell, and what do we pay them?" a single page.
 */

export const VENDOR_KINDS = ['supplier', 'manufacturer', 'service', 'software'] as const;

const vendorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    kinds: { type: [String], enum: VENDOR_KINDS, default: [] },

    website: { type: String, default: '' },
    email: { type: String, default: null, lowercase: true, trim: true },
    phone: { type: String, default: '' },
    contactName: { type: String, default: '' },
    /** Their reference for us — what to quote when calling support. */
    accountNumber: { type: String, default: '' },

    address: {
      line1: { type: String, default: '' },
      city: { type: String, default: '' },
      postcode: { type: String, default: '' },
      country: { type: String, default: '' },
    },

    notes: { type: String, default: '' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    searchTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

// A name is how people find a vendor, so two live "Dell"s is a mistake. Case-
// insensitive, and only among live records so a deleted one frees its name.
vendorSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, partialFilterExpression: { deletedAt: null } },
);
vendorSchema.index({ tenantId: 1, status: 1, name: 1 });
vendorSchema.index({ tenantId: 1, searchTokens: 1 });
vendorSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
vendorSchema.index({ tenantId: 1, deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } });

export type Vendor = InferSchemaType<typeof vendorSchema>;
export type VendorDocument = HydratedDocument<Vendor>;

export const VendorModel = defineModel('Vendor', vendorSchema);
