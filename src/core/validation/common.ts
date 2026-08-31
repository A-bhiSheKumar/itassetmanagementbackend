import { z } from 'zod';

/** Shared primitives so validation rules are defined once (docs/04 §2). */

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id.');

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Not a valid id.');

/** Identifiers are opaque to clients — accept either shape. */
export const idSchema = z.union([objectIdSchema, ulidSchema]);

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only.');

/**
 * Money is minor units plus an ISO code — never a float, never a bare number
 * (docs/03-data-model.md §2). 129900 GBP is £1,299.00.
 */
export const moneySchema = z.object({
  amount: z.number().int('Amounts are stored in minor units (pence, cents).'),
  currency: z.string().length(3).toUpperCase(),
});

/** Cursor pagination is the default for every large collection (ADR-010). */
export const cursorPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const sortSchema = z
  .string()
  .regex(/^-?[a-zA-Z][\w.]*$/, 'Sort looks like "name" or "-updatedAt".')
  .optional();
