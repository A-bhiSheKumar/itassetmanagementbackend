import { defineModel } from '../../core/db/index.js';
import { Schema, type InferSchemaType } from 'mongoose';

/**
 * Live usage counters.
 *
 * Maintained with $inc inside the same transaction as the entity write, and
 * fully recomputed nightly to correct any drift. Counting 200,000 assets on
 * every asset creation to check a plan limit is not viable, and a limit check
 * that is slow gets removed by the next person who profiles the endpoint.
 */
const tenantUsageSchema = new Schema(
  {
    seatsUsed: { type: Number, default: 0 },
    peopleCount: { type: Number, default: 0 },
    assetCount: { type: Number, default: 0 },
    storageBytes: { type: Number, default: 0 },
    customFieldCount: { type: Number, default: 0 },
    lastRecalculatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

tenantUsageSchema.index({ tenantId: 1 }, { unique: true });

export type TenantUsage = InferSchemaType<typeof tenantUsageSchema>;

export const TenantUsageModel = defineModel('TenantUsage', tenantUsageSchema);
