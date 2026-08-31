import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

const assetTypeSchema = new Schema(
  {
    key: { type: String, required: true, lowercase: true, trim: true, immutable: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    icon: { type: String, default: null },

    categoryId: { type: String, default: null },
    lifecycleWorkflowId: { type: String, default: null },

    /**
     * False means quantity-tracked stock rather than individually identified
     * items — cables, adapters, toner. The flag exists from M2 even though
     * consumables ship in v2: retrofitting it would mean splitting the asset
     * collection after it holds real data (docs/00-OVERVIEW.md §4).
     */
    isSerialised: { type: Boolean, default: true },
    requiresSerial: { type: Boolean, default: false },

    /** Overrides the tenant-wide prefix: LAP-0042 rather than AST-0042. */
    tagPrefix: { type: String, default: null, trim: true },

    defaultDepreciation: {
      method: {
        type: String,
        enum: ['none', 'straight_line', 'declining_balance'],
        default: 'none',
      },
      usefulLifeMonths: { type: Number, default: null },
      salvageValueMinor: { type: Number, default: 0 },
    },

    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

assetTypeSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
assetTypeSchema.index({ tenantId: 1, status: 1, name: 1 });
assetTypeSchema.index({ tenantId: 1, categoryId: 1 });

export type AssetType = InferSchemaType<typeof assetTypeSchema>;
export type AssetTypeDocument = HydratedDocument<AssetType>;

export const AssetTypeModel = defineModel('AssetType', assetTypeSchema);
