import { z } from 'zod';
import { strictObject, emailSchema, idSchema } from '../../core/validation/index.js';

export const inviteMemberSchema = {
  body: strictObject({
    email: emailSchema,
    roleIds: z.array(idSchema).min(1, 'Choose at least one role.'),
  }),
};

export const updateRolesSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    roleIds: z.array(idSchema).min(1, 'A member must have at least one role.'),
  }),
};

export const membershipIdSchema = {
  params: strictObject({ id: idSchema }),
};
