import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './asset.controller.js';
import {
  createAssetSchema,
  updateAssetSchema,
  assetIdSchema,
  listAssetsSchema,
  transitionSchema,
} from './asset.schema.js';

export const assetRoutes = Router();

assetRoutes.get('/', requirePermission('asset:read'), validate(listAssetsSchema), asyncHandler(controller.index));
assetRoutes.get('/summary', requirePermission('asset:read'), asyncHandler(controller.summary));

assetRoutes.post('/', requirePermission('asset:create'), validate(createAssetSchema), asyncHandler(controller.create));

assetRoutes.get('/:id', requirePermission('asset:read'), validate(assetIdSchema), asyncHandler(controller.show));
assetRoutes.patch('/:id', requirePermission('asset:update'), validate(updateAssetSchema), asyncHandler(controller.update));
assetRoutes.delete('/:id', requirePermission('asset:delete'), validate(assetIdSchema), asyncHandler(controller.destroy));
assetRoutes.post('/:id/restore', requirePermission('asset:delete'), validate(assetIdSchema), asyncHandler(controller.restore));

// GET /assets/:id/assignments belongs to the assignments module — see the
// note in assignment.routes.ts. Keeping it here would make assets depend on
// assignments and assignments on assets, which is a cycle.
assetRoutes.get('/:id/timeline', requirePermission('asset:read'), validate(assetIdSchema), asyncHandler(controller.timeline));
assetRoutes.get('/:id/transitions', requirePermission('asset:read'), validate(assetIdSchema), asyncHandler(controller.transitions));

assetRoutes.post(
  '/:id/transition',
  requirePermission('asset:transition'),
  validate(transitionSchema),
  asyncHandler(controller.transition),
);
