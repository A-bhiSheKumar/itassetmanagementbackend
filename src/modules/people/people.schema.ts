import { z } from 'zod';
import { strictObject, idSchema, emailSchema, cursorPaginationSchema } from '../../core/validation/index.js';

/**
 * Custom field values arrive flat and typed loosely here, then are validated
 * against the tenant's own definitions by the compiler. Zod cannot know the
 * shape at schema-definition time — that is the entire point of the feature.
 */
const customFieldsInput = z.record(z.string(), z.unknown()).optional();

const personBody = {
  firstName: z.string().trim().min(1, 'Enter a first name.').max(80),
  lastName: z.string().trim().min(1, 'Enter a last name.').max(80),
  email: emailSchema.nullish(),
  employeeCode: z.string().trim().max(40).nullish(),
  phone: z.string().trim().max(40).nullish(),
  jobTitle: z.string().trim().max(120).optional(),
  departmentId: idSchema.nullish(),
  locationId: idSchema.nullish(),
  costCentreId: idSchema.nullish(),
  managerId: idSchema.nullish(),
  type: z.enum(['employee', 'contractor', 'service_account']).optional(),
  startDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
  customFields: customFieldsInput,
};

export const listPeopleSchema = {
  query: cursorPaginationSchema.extend({
    status: z.enum(['active', 'on_leave', 'offboarding', 'inactive']).optional(),
    departmentId: idSchema.optional(),
    locationId: idSchema.optional(),
    q: z.string().trim().max(80).optional(),
  }),
};

export const createPersonSchema = { body: strictObject(personBody) };

export const updatePersonSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject(personBody).partial(),
};

export const personIdSchema = { params: strictObject({ id: idSchema }) };

const orgUnitBody = {
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  code: z.string().trim().max(40).nullish(),
  description: z.string().max(500).optional(),
  parentId: idSchema.nullish(),
  managerId: idSchema.nullish(),
};

const addressBody = strictObject({
  line1: z.string().max(120).optional(),
  line2: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  postcode: z.string().max(20).optional(),
  country: z.string().max(80).optional(),
}).optional();

export const createOrgUnitSchema = { body: strictObject(orgUnitBody) };
export const updateOrgUnitSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject(orgUnitBody).partial(),
};

export const createLocationSchema = {
  body: strictObject({
    ...orgUnitBody,
    address: addressBody,
    timezone: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Not a recognised time zone.')
      .nullish(),
  }),
};

export const updateLocationSchema = {
  params: strictObject({ id: idSchema }),
  body: createLocationSchema.body.partial(),
};
