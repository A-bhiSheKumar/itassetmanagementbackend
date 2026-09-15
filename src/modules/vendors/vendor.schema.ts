import { z } from 'zod';
import { strictObject, idSchema, emailSchema, cursorPaginationSchema } from '../../core/validation/index.js';
import { VENDOR_KINDS } from './vendor.model.js';

const vendorBody = {
  name: z.string().trim().min(1, 'Enter a name.').max(160),
  kinds: z.array(z.enum(VENDOR_KINDS)).max(VENDOR_KINDS.length).optional(),
  website: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'Start with http:// or https://')
    .optional(),
  email: emailSchema.nullish(),
  phone: z.string().trim().max(60).optional(),
  contactName: z.string().trim().max(160).optional(),
  accountNumber: z.string().trim().max(80).optional(),
  address: strictObject({
    line1: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    postcode: z.string().max(20).optional(),
    country: z.string().max(120).optional(),
  }).optional(),
  notes: z.string().max(5000).optional(),
};

export const listVendorsSchema = {
  query: cursorPaginationSchema
    .extend({
      q: z.string().trim().max(80).optional(),
      status: z.enum(['active', 'archived']).optional(),
      kind: z.enum(VENDOR_KINDS).optional(),
    })
    .strict(),
};

export const createVendorSchema = { body: strictObject(vendorBody) };

export const updateVendorSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({ ...vendorBody, status: z.enum(['active', 'archived']).optional() }).partial(),
};

export const vendorIdSchema = { params: strictObject({ id: idSchema }) };
