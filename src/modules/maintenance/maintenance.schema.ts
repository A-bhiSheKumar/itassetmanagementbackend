import { z } from 'zod';
import { strictObject, idSchema, cursorPaginationSchema } from '../../core/validation/index.js';
import { MAINTENANCE_STATUSES, MAINTENANCE_TYPES } from './maintenance.model.js';

const date = z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
const cost = strictObject({
  amountMinor: z.number().int().min(0).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter code, like GBP.').nullable(),
});

const body = {
  vendorId: idSchema.nullish(),
  type: z.enum(MAINTENANCE_TYPES),
  title: z.string().trim().min(1, 'Say what the work is.').max(200),
  description: z.string().max(5000).optional(),
  scheduledFor: date.nullish(),
  performedBy: z.string().trim().max(200).optional(),
  cost: cost.optional(),
  recurrenceMonths: z.number().int().min(1).max(120).nullish(),
};

export const listMaintenanceSchema = {
  query: cursorPaginationSchema
    .extend({
      assetId: idSchema.optional(),
      vendorId: idSchema.optional(),
      status: z.enum(MAINTENANCE_STATUSES).optional(),
      overdue: z.enum(['true']).transform(() => true).optional(),
    })
    .strict(),
};

export const createMaintenanceSchema = {
  body: strictObject({
    ...body,
    assetId: idSchema,
    /** Start straight away rather than scheduling — the laptop is already at the repair shop. */
    startNow: z.boolean().optional(),
    moveAsset: z.boolean().optional(),
  }),
};

export const updateMaintenanceSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({ ...body, outcome: z.string().max(5000).optional() }).partial(),
};

export const startMaintenanceSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({ moveAsset: z.boolean().optional() }),
};

export const completeMaintenanceSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    completedAt: date.optional(),
    outcome: z.string().max(5000).optional(),
    cost: cost.optional(),
    performedBy: z.string().trim().max(200).optional(),
    /** Set the asset's condition after the work, e.g. back to good after a repair. */
    condition: z.enum(['new', 'good', 'fair', 'poor', 'damaged']).optional(),
  }),
};

export const maintenanceIdSchema = { params: strictObject({ id: idSchema }) };
