import { z } from 'zod';
import { strictObject, idSchema } from '../../core/validation/index.js';
import { CUSTOM_FIELD_TYPES } from './customFieldValues.js';

const optionInput = strictObject({
  id: z.string().optional(),
  label: z.string().trim().min(1).max(80),
  colour: z.string().max(20).optional(),
  archived: z.boolean().optional(),
});

export const createAssetTypeSchema = {
  body: strictObject({
    name: z.string().trim().min(1, 'Give this type a name.').max(80),
    categoryId: idSchema.nullish(),
    icon: z.string().max(40).nullish(),
    tagPrefix: z
      .string()
      .trim()
      .max(8)
      .regex(/^[A-Za-z0-9-]*$/, 'Letters, numbers and hyphens only.')
      .nullish(),
    isSerialised: z.boolean().optional(),
    requiresSerial: z.boolean().optional(),
  }),
};

export const createCategorySchema = {
  body: strictObject({
    name: z.string().trim().min(1).max(80),
    parentId: idSchema.nullish(),
    icon: z.string().max(40).nullish(),
    colour: z.string().max(20).nullish(),
    description: z.string().max(500).optional(),
  }),
};

export const listFieldsSchema = {
  query: strictObject({
    appliesTo: z.enum(['asset', 'person', 'vendor', 'licence']).default('asset'),
    assetTypeId: idSchema.optional(),
    includeArchived: z.enum(['true', 'false']).optional(),
  }),
};

export const createFieldSchema = {
  body: strictObject({
    appliesTo: z.enum(['asset', 'person', 'vendor', 'licence']),
    label: z.string().trim().min(1, 'Give this field a name.').max(60),
    type: z.enum(CUSTOM_FIELD_TYPES),
    assetTypeIds: z.array(idSchema).max(50).optional(),
    options: z.array(optionInput).max(200).optional(),
    validation: strictObject({
      required: z.boolean().optional(),
      min: z.number().nullish(),
      max: z.number().nullish(),
      regex: z.string().max(200).nullish(),
      maxLength: z.number().int().positive().max(10_000).nullish(),
      referenceTo: z.string().max(40).nullish(),
      currency: z.string().length(3).nullish(),
    }).optional(),
    display: strictObject({
      section: z.string().max(40).optional(),
      order: z.number().int().optional(),
      helpText: z.string().max(200).optional(),
      placeholder: z.string().max(80).optional(),
      showInTable: z.boolean().optional(),
    }).optional(),
    flags: strictObject({
      isPii: z.boolean().optional(),
      isSearchable: z.boolean().optional(),
      isReadOnlyFromIntegration: z.boolean().optional(),
    }).optional(),
  }),
};

/**
 * `key`, `type` and `appliesTo` are absent on purpose.
 *
 * They are immutable in the schema too, but rejecting them at the boundary
 * gives the caller a clear message instead of a silently ignored change.
 */
export const updateFieldSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    label: z.string().trim().min(1).max(60).optional(),
    assetTypeIds: z.array(idSchema).max(50).optional(),
    options: z.array(optionInput).max(200).optional(),
    validation: strictObject({
      required: z.boolean().optional(),
      min: z.number().nullish(),
      max: z.number().nullish(),
      regex: z.string().max(200).nullish(),
      maxLength: z.number().int().positive().max(10_000).nullish(),
      referenceTo: z.string().max(40).nullish(),
      currency: z.string().length(3).nullish(),
    }).optional(),
    display: strictObject({
      section: z.string().max(40).optional(),
      order: z.number().int().optional(),
      helpText: z.string().max(200).optional(),
      placeholder: z.string().max(80).optional(),
      showInTable: z.boolean().optional(),
    }).optional(),
    flags: strictObject({
      isPii: z.boolean().optional(),
      isSearchable: z.boolean().optional(),
      isReadOnlyFromIntegration: z.boolean().optional(),
    }).optional(),
  }),
};

export const idParamSchema = { params: strictObject({ id: idSchema }) };

export const transitionsFromSchema = {
  params: strictObject({ from: z.string().min(1).max(40) }),
  query: strictObject({ assetTypeId: idSchema.optional() }),
};
