import { z } from 'zod';
import { strictObject, idSchema } from '../../core/validation/index.js';

export const presignSchema = {
  body: strictObject({
    entityType: z.enum(['asset', 'person', 'vendor', 'licence', 'maintenance']),
    entityId: idSchema,
    fileName: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
    category: z.enum(['invoice', 'warranty', 'contract', 'photo', 'receipt', 'report', 'other']).optional(),
  }),
};

export const listDocumentsSchema = {
  query: strictObject({
    entityType: z.enum(['asset', 'person', 'vendor', 'licence', 'maintenance']),
    entityId: idSchema,
  }),
};

export const documentIdSchema = { params: strictObject({ id: idSchema }) };

/** The local-storage stand-ins are authorised by the URL signature, not a token. */
export const signedUrlSchema = {
  query: strictObject({
    key: z.string().min(1).max(400),
    expires: z.string().regex(/^\d+$/),
    signature: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
  }),
};
