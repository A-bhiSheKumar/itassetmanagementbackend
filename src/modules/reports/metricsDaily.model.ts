import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * Pre-computed dashboard figures, one document per tenant per day.
 *
 * The dashboard reads THIS, never the asset collection. Running six `$group`
 * pipelines over 500,000 assets on every dashboard load is the first thing that
 * falls over, and it falls over for the customer who matters most — the biggest
 * one (ADR-011).
 *
 * Rebuildable from scratch at any time, so a bad rollup is a job re-run rather
 * than a data-loss incident.
 */
const metricsDailySchema = new Schema(
  {
    /** UTC date at midnight — the grain of the rollup. */
    date: { type: Date, required: true },

    totalAssets: { type: Number, default: 0 },
    assignedAssets: { type: Number, default: 0 },
    availableAssets: { type: Number, default: 0 },

    byState: { type: Schema.Types.Mixed, default: {} },
    byCategory: { type: Schema.Types.Mixed, default: {} },
    byLocation: { type: Schema.Types.Mixed, default: {} },
    byCondition: { type: Schema.Types.Mixed, default: {} },

    /** Minor units, in the tenant's configured currency. */
    totalValueMinor: { type: Number, default: 0 },

    peopleCount: { type: Number, default: 0 },
    expiringWarranties30d: { type: Number, default: 0 },
    unacknowledgedAssignments: { type: Number, default: 0 },

    computedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

metricsDailySchema.index({ tenantId: 1, date: -1 }, { unique: true });

export type MetricsDaily = Scoped<InferSchemaType<typeof metricsDailySchema>>;

export const MetricsDailyModel = defineModel(
  'MetricsDaily',
  metricsDailySchema,
) as unknown as Model<MetricsDaily>;
