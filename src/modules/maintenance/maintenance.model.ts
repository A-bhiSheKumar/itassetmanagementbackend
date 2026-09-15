import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

/**
 * Work done on an asset: repairs, services, upgrades, inspections.
 *
 * Its own collection rather than entries on the asset, for the same reason as
 * assignments — a five-year-old printer collects dozens, and "everything
 * serviced by this vendor this year" has to be one query, not a scan of every
 * asset.
 */

export const MAINTENANCE_TYPES = ['repair', 'service', 'upgrade', 'inspection', 'calibration', 'other'] as const;
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;

const maintenanceSchema = new Schema(
  {
    assetId: { type: String, required: true },
    vendorId: { type: String, default: null },

    type: { type: String, enum: MAINTENANCE_TYPES, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    status: { type: String, enum: MAINTENANCE_STATUSES, default: 'scheduled' },
    scheduledFor: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    cost: {
      amountMinor: { type: Number, default: null },
      currency: { type: String, default: null },
    },
    performedBy: { type: String, default: '' },
    outcome: { type: String, default: '' },

    /** Every N months: completing this one schedules the next. */
    recurrenceMonths: { type: Number, default: null },
    previousRecordId: { type: String, default: null },
    nextRecordId: { type: String, default: null },

    /**
     * The asset's state before this record moved it to maintenance, so
     * finishing can put it back. Null when the asset was never moved.
     */
    assetStateBefore: { type: String, default: null },

    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

// An asset's maintenance history, newest first.
maintenanceSchema.index({ tenantId: 1, assetId: 1, createdAt: -1 });
// What is due: open records by date. Powers the overdue count on every dashboard load.
maintenanceSchema.index({ tenantId: 1, status: 1, scheduledFor: 1 });
maintenanceSchema.index({ tenantId: 1, vendorId: 1, createdAt: -1 });
maintenanceSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
maintenanceSchema.index({ tenantId: 1, deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } });

export type MaintenanceRecord = InferSchemaType<typeof maintenanceSchema>;
export type MaintenanceDocument = HydratedDocument<MaintenanceRecord>;

export const MaintenanceModel = defineModel('MaintenanceRecord', maintenanceSchema);
