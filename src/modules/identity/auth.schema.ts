import { z } from 'zod';
import { strictObject, emailSchema, idSchema } from '../../core/validation/index.js';

/**
 * Minimum 12 characters, no composition rules.
 *
 * Deliberate: "one uppercase, one digit, one symbol" produces Password1! across
 * an entire customer base. Length is what actually resists offline cracking.
 * A HaveIBeenPwned range check is added in M6.
 */
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'That is longer than 128 characters.');

export const registerSchema = {
  body: strictObject({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1, 'Enter your name.').max(120),
    organisationName: z.string().trim().min(1, 'Enter your organisation name.').max(120),
  }),
};

export const loginSchema = {
  body: strictObject({
    email: emailSchema,
    // Not passwordSchema: an existing password may predate the current rule,
    // and validating length here would leak the rule to an attacker anyway.
    password: z.string().min(1, 'Enter your password.'),
  }),
};

export const selectTenantSchema = {
  body: strictObject({ tenantId: idSchema }),
};

export const acceptInvitationSchema = {
  body: strictObject({
    token: z.string().min(20),
    password: passwordSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }),
};

export const changePasswordSchema = {
  body: strictObject({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
  }),
};
