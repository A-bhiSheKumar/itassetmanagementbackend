import { z } from 'zod';
import { strictObject, idSchema } from '../../core/validation/index.js';

/** Step 1a: reserve a place in storage for the spreadsheet. */
export const importUploadSchema = {
  body: strictObject({
    fileName: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().positive(),
  }),
};

/**
 * Step 1b: stage the uploaded file.
 *
 * The file is NOT in this request. It was uploaded straight to storage and is
 * named by `uploadKey` — on Lambda a request body cannot exceed 6 MB, and a
 * real estate's spreadsheet can.
 */
export const createImportSchema = {
  body: strictObject({
    uploadKey: z.string().min(1).max(400),
    entityType: z.enum(['asset', 'person']),
    fileName: z.string().trim().min(1).max(200),
    // Required for asset imports; the service rejects it if absent, with a
    // message that says what to do rather than "invalid".
    assetTypeId: idSchema.optional(),
  }),
};

export const targetsSchema = {
  query: strictObject({
    entityType: z.enum(['asset', 'person']),
    assetTypeId: idSchema.optional(),
  }),
};

export const mappingSchema = {
  params: strictObject({ id: idSchema }),
  body: strictObject({
    /** Header → field key. An empty value means "ignore this column". */
    columnMapping: z.record(z.string().max(200), z.string().max(80)),
    duplicateStrategy: z.enum(['skip', 'update', 'error']).optional(),
    // Never inferred: 03/04/2026 is two different dates depending on locale.
    dateFormat: z.enum(['DMY', 'MDY', 'ISO']).optional(),
    createMissingReferences: z.boolean().optional(),
  }),
};

export const importIdSchema = { params: strictObject({ id: idSchema }) };

export const rowsSchema = {
  params: strictObject({ id: idSchema }),
  query: strictObject({
    status: z.enum(['valid', 'invalid', 'duplicate', 'created', 'updated', 'skipped', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
};

export const entityTypeParamSchema = {
  params: strictObject({ entityType: z.enum(['asset', 'person']) }),
};

export const exportSchema = {
  params: strictObject({ entityType: z.enum(['asset', 'person']) }),
  query: strictObject({
    lifecycleState: z.string().max(200).optional(),
    assetTypeId: idSchema.optional(),
    locationId: idSchema.optional(),
    condition: z.string().max(20).optional(),
    q: z.string().trim().max(80).optional(),
  }),
};
