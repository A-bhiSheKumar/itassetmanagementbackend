import { z } from 'zod';
import { strictObject, idSchema } from '../../core/validation/index.js';

const condition = z.enum(['new', 'good', 'fair', 'poor', 'damaged', 'unknown']);

export const assignSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    assigneeId: idSchema,
    assigneeType: z.enum(['person', 'location', 'asset']).optional(),
    dueAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
    notes: z.string().max(1000).optional(),
    requireAcknowledgement: z.boolean().optional(),
    conditionOut: condition.optional(),
  }),
};

export const returnSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    condition: condition.optional(),
    notes: z.string().max(1000).optional(),
    returnedTo: idSchema.nullish(),
  }),
};

export const transferSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    toAssigneeId: idSchema,
    assigneeType: z.enum(['person', 'location', 'asset']).optional(),
    notes: z.string().max(1000).optional(),
    condition: condition.optional(),
  }),
};

export const listAssignmentsSchema = {
  query: strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    assigneeId: idSchema.optional(),
    status: z.enum(['active', 'returned', 'cancelled']).optional(),
  }),
};

export const acknowledgeSchema = {
  body: strictObject({ token: z.string().min(20).max(200) }),
};

export const personIdSchema = { params: strictObject({ id: idSchema }) };
