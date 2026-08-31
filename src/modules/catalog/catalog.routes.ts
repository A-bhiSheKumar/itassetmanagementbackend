import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './catalog.controller.js';
import {
  createAssetTypeSchema,
  createCategorySchema,
  listFieldsSchema,
  createFieldSchema,
  updateFieldSchema,
  idParamSchema,
  transitionsFromSchema,
} from './catalog.schema.js';

export const catalogRoutes = Router();

// ── Asset types ────────────────────────────────────────────────────────────
catalogRoutes.get('/asset-types', requirePermission('asset:read'), asyncHandler(controller.types));
catalogRoutes.post(
  '/asset-types',
  requirePermission('settings:manage'),
  validate(createAssetTypeSchema),
  asyncHandler(controller.createType),
);
catalogRoutes.post(
  '/asset-types/:id/archive',
  requirePermission('settings:manage'),
  validate(idParamSchema),
  asyncHandler(controller.archiveType),
);

// ── Categories ─────────────────────────────────────────────────────────────
catalogRoutes.get('/asset-categories', requirePermission('asset:read'), asyncHandler(controller.categories));
catalogRoutes.post(
  '/asset-categories',
  requirePermission('settings:manage'),
  validate(createCategorySchema),
  asyncHandler(controller.createCategory),
);

// ── Custom fields ──────────────────────────────────────────────────────────
// Reading definitions needs only asset:read — every form and filter depends on
// it, so gating it behind settings:manage would break the app for Members.
catalogRoutes.get(
  '/custom-fields',
  requirePermission('asset:read'),
  validate(listFieldsSchema),
  asyncHandler(controller.fields),
);
catalogRoutes.get(
  '/custom-fields/:id',
  requirePermission('asset:read'),
  validate(idParamSchema),
  asyncHandler(controller.showField),
);
catalogRoutes.post(
  '/custom-fields',
  requirePermission('customField:manage'),
  validate(createFieldSchema),
  asyncHandler(controller.createField),
);
catalogRoutes.patch(
  '/custom-fields/:id',
  requirePermission('customField:manage'),
  validate(updateFieldSchema),
  asyncHandler(controller.updateField),
);
catalogRoutes.post(
  '/custom-fields/:id/archive',
  requirePermission('customField:manage'),
  validate(idParamSchema),
  asyncHandler(controller.archiveField),
);
catalogRoutes.post(
  '/custom-fields/:id/restore',
  requirePermission('customField:manage'),
  validate(idParamSchema),
  asyncHandler(controller.restoreField),
);

// ── Lifecycle ──────────────────────────────────────────────────────────────
catalogRoutes.get('/lifecycle', requirePermission('asset:read'), asyncHandler(controller.workflows));
catalogRoutes.get(
  '/lifecycle/transitions/:from',
  requirePermission('asset:read'),
  validate(transitionsFromSchema),
  asyncHandler(controller.transitionsFrom),
);
