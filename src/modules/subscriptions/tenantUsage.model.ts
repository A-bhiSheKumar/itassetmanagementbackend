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

/**
 * Named explicitly.
 *
 * The tenant-scope plugin already declares `tenantId` as indexed, which
 * auto-generates the name `tenantId_1`. A second index on the same key with
 * different options collides on that name, and MongoDB refuses it — so this
 * unique constraint silently never existed and a tenant could have ended up
 * with two of these. Surfaced by the index-error logging in core/db.
 */
tenantUsageSchema.index({ tenantId: 1 }, { unique: true, name: 'tenantId_unique' });

export type TenantUsage = InferSchemaType<typeof tenantUsageSchema>;

export const TenantUsageModel = defineModel('TenantUsage', tenantUsageSchema);
