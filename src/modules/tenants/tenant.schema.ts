import { z } from 'zod';
import { strictObject } from '../../core/validation/index.js';

export const updateTenantSchema = {
  body: strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    settings: strictObject({
      // Validated against the runtime's own zone database rather than a
      // hardcoded list, so it cannot go stale.
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
        .optional(),
      locale: z.string().min(2).max(10).optional(),
      currency: z.string().length(3).toUpperCase().optional(),
      assetTagPrefix: z
        .string()
        .trim()
        .min(1)
        .max(8)
        .regex(/^[A-Z0-9-]+$/i, 'Letters, numbers and hyphens only.')
        .optional(),
      allowImpersonation: z.boolean().optional(),
    }).optional(),
  }),
};
