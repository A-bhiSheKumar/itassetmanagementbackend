import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

/**
 * A software licence or subscription, and who is using its seats.
 *
 * Seats are counted on the licence (`seatsUsed`) as well as recorded one by one
 * in LicenceSeat. The count is what makes "never over-allocate" enforceable
 * under concurrency: allocating is a conditional increment that only matches
 * while a seat is free, in the same transaction as the seat record.
 */

export const LICENCE_TYPES = ['subscription', 'perpetual', 'volume', 'site', 'trial'] as const;
export const BILLING_CYCLES = ['monthly', 'annual', 'multi_year', 'one_off'] as const;

const licenceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    vendorId: { type: String, default: null },
    type: { type: String, enum: LICENCE_TYPES, required: true },

    /** Null: unlimited — a site licence, or a subscription billed on usage. */
    seats: { type: Number, default: null },
    seatsUsed: { type: Number, default: 0 },

    /** AES-GCM ciphertext (core/crypto). The plaintext is never stored or logged. */
    keyEncrypted: { type: String, default: null, select: false },
    /** The last four characters, so two keys can be told apart without revealing either. */
    keyHint: { type: String, default: null },

    purchasedAt: { type: Date, default: null },
    startsAt: { type: Date, default: null },
    /** When it lapses or renews. Null for perpetual licences. */
    expiresAt: { type: Date, default: null },
    autoRenew: { type: Boolean, default: false },
    billingCycle: { type: String, enum: [...BILLING_CYCLES, null], default: null },
    cost: {
      amountMinor: { type: Number, default: null },
      currency: { type: String, default: null },
    },
    orderRef: { type: String, default: '' },
    notes: { type: String, default: '' },

    status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
    searchTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Renewals due. Partial on having a date, like warranties, so perpetual licences never enter it.
licenceSchema.index({ tenantId: 1, expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: 'date' } } });
licenceSchema.index({ tenantId: 1, vendorId: 1, createdAt: -1 });
licenceSchema.index({ tenantId: 1, searchTokens: 1 });
licenceSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
licenceSchema.index({ tenantId: 1, deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } });

export type Licence = InferSchemaType<typeof licenceSchema>;
export type LicenceDocument = HydratedDocument<Licence>;
export const LicenceModel = defineModel('Licence', licenceSchema);

const seatSchema = new Schema(
  {
    licenceId: { type: String, required: true },
    assigneeType: { type: String, enum: ['person', 'asset'], required: true },
    assigneeId: { type: String, required: true },
    assignedAt: { type: Date, required: true, default: () => new Date() },
    assignedBy: { type: String, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

// One live seat per assignee per licence — the database refuses a double allocation.
seatSchema.index(
  { tenantId: 1, licenceId: 1, assigneeType: 1, assigneeId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);
seatSchema.index({ tenantId: 1, licenceId: 1, revokedAt: 1, assignedAt: -1 });
// Everything someone uses — the person page, and the offboarding checklist.
seatSchema.index({ tenantId: 1, assigneeId: 1, revokedAt: 1 });

export type LicenceSeat = InferSchemaType<typeof seatSchema>;
export type LicenceSeatDocument = HydratedDocument<LicenceSeat>;
export const LicenceSeatModel = defineModel('LicenceSeat', seatSchema);
