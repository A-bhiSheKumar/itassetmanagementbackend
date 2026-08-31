import { z } from 'zod';
import { strictObject, idSchema, cursorPaginationSchema } from '../../core/validation/index.js';

const customFieldsInput = z.record(z.string(), z.unknown()).optional();

const moneyish = {
  date: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
  /** Minor units, always. Never a float on the wire (docs/03 §2). */
  priceMinor: z.number().int().nullish(),
  currency: z.string().length(3).toUpperCase().nullish(),
  vendorId: idSchema.nullish(),
  orderRef: z.string().max(80).optional(),
};

const assetBody = {
  name: z.string().trim().min(1, 'Give this asset a name.').max(160),
  assetTypeId: idSchema,
  assetTag: z.string().trim().max(40).optional(),
  serialNumber: z.string().trim().max(120).nullish(),
  model: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  description: z.string().max(2000).optional(),
  condition: z.enum(['new', 'good', 'fair', 'poor', 'damaged', 'unknown']).optional(),
  categoryId: idSchema.nullish(),
  purchase: strictObject(moneyish).optional(),
  warranty: strictObject({
    provider: z.string().max(120).optional(),
    startsAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
    expiresAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
  }).optional(),
  placement: strictObject({
    locationId: idSchema.nullish(),
    departmentId: idSchema.nullish(),
    subLocation: z.string().max(120).optional(),
  }).optional(),
  customFields: customFieldsInput,
};

export const createAssetSchema = { body: strictObject(assetBody) };

export const updateAssetSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    ...assetBody,
    /** Optimistic lock. Omit to accept last-write-wins. */
    version: z.number().int().optional(),
  })
    .partial()
    .omit({ assetTypeId: true }),
};

export const assetIdSchema = { params: strictObject({ id: idSchema }) };

/**
 * `filter` is passed through loosely and parsed by the controller, because the
 * custom-field paths are defined by the tenant at runtime — a static schema
 * cannot enumerate them. The controller allowlists the operators.
 */
export const listAssetsSchema = {
  query: cursorPaginationSchema
    .extend({
      lifecycleState: z.string().max(200).optional(),
      assetTypeId: idSchema.optional(),
      categoryId: idSchema.optional(),
      locationId: idSchema.optional(),
      departmentId: idSchema.optional(),
      condition: z.string().max(20).optional(),
      assigneeId: idSchema.optional(),
      unassigned: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
      q: z.string().trim().max(80).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
};

export const transitionSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    to: z.string().min(1).max(40),
    comment: z.string().max(1000).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
};
