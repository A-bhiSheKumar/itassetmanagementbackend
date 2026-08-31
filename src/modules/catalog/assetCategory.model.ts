import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

const assetCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    parentId: { type: String, default: null },
    path: { type: [String], default: [] },
    icon: { type: String, default: null },
    colour: { type: String, default: null },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

assetCategorySchema.index({ tenantId: 1, status: 1, name: 1 });
assetCategorySchema.index({ tenantId: 1, parentId: 1, name: 1 });
assetCategorySchema.index({ tenantId: 1, path: 1 });

export type AssetCategory = InferSchemaType<typeof assetCategorySchema>;
export type AssetCategoryDocument = HydratedDocument<AssetCategory>;

export const AssetCategoryModel = defineModel('AssetCategory', assetCategorySchema);
