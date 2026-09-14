import { z } from 'zod';
import { strictObject, idSchema } from '../../core/validation/index.js';

const orgUnitBody = {
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  code: z.string().trim().max(40).nullish(),
  description: z.string().max(500).optional(),
  parentId: idSchema.nullish(),
  managerId: idSchema.nullish(),
};

/** Archiving is an edit, not a create: nothing is born archived. */
const status = z.enum(['active', 'archived']).optional();

const addressBody = strictObject({
  line1: z.string().max(120).optional(),
  line2: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  postcode: z.string().max(20).optional(),
  country: z.string().max(80).optional(),
}).optional();

const timezone = z
  .string()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Not a recognised time zone.')
  .nullish();

const unitId = strictObject({ id: idSchema });

export const createOrgUnitSchema = { body: strictObject(orgUnitBody) };
export const updateOrgUnitSchema = {
  params: unitId,
  body: strictObject({ ...orgUnitBody, status }).partial(),
};

export const createLocationSchema = {
  body: strictObject({ ...orgUnitBody, address: addressBody, timezone }),
};
export const updateLocationSchema = {
  params: unitId,
  body: strictObject({ ...orgUnitBody, status, address: addressBody, timezone }).partial(),
};

export const unitIdSchema = { params: unitId };

export const moveContentsSchema = {
  params: unitId,
  body: strictObject({ toId: idSchema }),
};
