import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission, requireAuth, markPublic } from '../../core/authz/index.js';
import { show, update, usage, industries, applyIndustryPreset } from './tenant.controller.js';
import { updateTenantSchema, applyPresetSchema } from './tenant.schema.js';

export const tenantRoutes = Router();

// Reference data for the signup screen, before any account exists.
tenantRoutes.get('/industries', markPublic(), asyncHandler(industries));

// Any member may see which organisation they are in and its settings.
tenantRoutes.get('/', requireAuth(), asyncHandler(show));

tenantRoutes.patch(
  '/',
  requirePermission('settings:manage'),
  validate(updateTenantSchema),
  asyncHandler(update),
);

tenantRoutes.post(
  '/industry-preset',
  requirePermission('settings:manage'),
  validate(applyPresetSchema),
  asyncHandler(applyIndustryPreset),
);

tenantRoutes.get('/usage', requirePermission('settings:manage'), asyncHandler(usage));
