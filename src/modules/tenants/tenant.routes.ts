import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission, requireAuth } from '../../core/authz/index.js';
import { show, update, usage } from './tenant.controller.js';
import { updateTenantSchema } from './tenant.schema.js';

export const tenantRoutes = Router();

// Any member may see which organisation they are in and its settings.
tenantRoutes.get('/', requireAuth(), asyncHandler(show));

tenantRoutes.patch(
  '/',
  requirePermission('settings:manage'),
  validate(updateTenantSchema),
  asyncHandler(update),
);

tenantRoutes.get('/usage', requirePermission('settings:manage'), asyncHandler(usage));
