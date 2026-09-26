import { z } from 'zod';
import { strictObject } from '../../core/validation/index.js';
import { INDUSTRY_KEYS } from '../catalog/index.js';

export const applyPresetSchema = {
  body: strictObject({
    industry: z.enum(INDUSTRY_KEYS as [string, ...string[]]),
    /** Also rename things and switch sections to match the preset. */
    adoptWording: z.boolean().optional(),
  }),
};

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
      industry: z.enum(INDUSTRY_KEYS as [string, ...string[]]).optional(),
      vocabulary: strictObject({
        asset: z.string().trim().min(1).max(24),
        assets: z.string().trim().min(1).max(24),
        person: z.string().trim().min(1).max(24),
        people: z.string().trim().min(1).max(24),
      }).optional(),
      modules: strictObject({
        maintenance: z.boolean(),
        licences: z.boolean(),
        vendors: z.boolean(),
      }).optional(),
    }).optional(),
  }),
};
