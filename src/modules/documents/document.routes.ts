import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission, markPublic } from '../../core/authz/index.js';
import * as controller from './document.controller.js';
import {
  presignSchema,
  listDocumentsSchema,
  documentIdSchema,
  signedUrlSchema,
} from './document.schema.js';

export const documentRoutes = Router();

/**
 * The local-storage stand-ins for S3's presigned PUT/GET.
 *
 * Public by necessity and by design: a presigned URL carries its own
 * authorisation in an expiring HMAC signature, exactly as S3's does. They are
 * declared before the guarded routes so `/upload` is not swallowed by `/:id`.
 */
documentRoutes.put('/upload', markPublic(), validate(signedUrlSchema), asyncHandler(controller.localUpload));
documentRoutes.get('/download', markPublic(), validate(signedUrlSchema), asyncHandler(controller.localDownload));

documentRoutes.get(
  '/',
  requirePermission('asset:read'),
  validate(listDocumentsSchema),
  asyncHandler(controller.index),
);

documentRoutes.post(
  '/presign',
  requirePermission('asset:update'),
  validate(presignSchema),
  asyncHandler(controller.presign),
);

documentRoutes.post(
  '/:id/confirm',
  requirePermission('asset:update'),
  validate(documentIdSchema),
  asyncHandler(controller.confirm),
);

documentRoutes.get(
  '/:id/download',
  requirePermission('asset:read'),
  validate(documentIdSchema),
  asyncHandler(controller.download),
);

documentRoutes.delete(
  '/:id',
  requirePermission('asset:update'),
  validate(documentIdSchema),
  asyncHandler(controller.destroy),
);
