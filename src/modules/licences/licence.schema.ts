import { z } from 'zod';
import { strictObject, idSchema, cursorPaginationSchema } from '../../core/validation/index.js';
import { BILLING_CYCLES, LICENCE_TYPES } from './licence.model.js';

const date = z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

const body = {
  name: z.string().trim().min(1, 'Enter a name.').max(200),
  vendorId: idSchema.nullish(),
  type: z.enum(LICENCE_TYPES),
  seats: z.number().int().min(1, 'At least one seat, or leave empty for unlimited.').max(1_000_000).nullish(),
  /** Write-only. Sent in plain text over TLS, stored encrypted, returned only by the reveal endpoint. */
  key: z.string().trim().max(4000).nullish(),
  purchasedAt: date.nullish(),
  startsAt: date.nullish(),
  expiresAt: date.nullish(),
  autoRenew: z.boolean().optional(),
  billingCycle: z.enum(BILLING_CYCLES).nullish(),
  cost: strictObject({
    amountMinor: z.number().int().min(0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter code, like GBP.').nullable(),
  }).optional(),
  orderRef: z.string().max(120).optional(),
  notes: z.string().max(5000).optional(),
};

export const listLicencesSchema = {
  query: cursorPaginationSchema
    .extend({
      q: z.string().trim().max(80).optional(),
      vendorId: idSchema.optional(),
      status: z.enum(['active', 'cancelled']).optional(),
      renewingWithinDays: z.coerce.number().int().min(1).max(365).optional(),
    })
    .strict(),
};

export const createLicenceSchema = { body: strictObject(body) };
export const updateLicenceSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({ ...body, status: z.enum(['active', 'cancelled']).optional() }).partial(),
};
export const licenceIdSchema = { params: strictObject({ id: idSchema }) };

export const allocateSeatSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    assigneeType: z.enum(['person', 'asset']).default('person'),
    assigneeId: idSchema,
    notes: z.string().max(1000).optional(),
  }),
};

export const seatIdSchema = { params: strictObject({ id: idSchema, seatId: idSchema }) };

export const seatsForSchema = { params: strictObject({ id: idSchema }) };
