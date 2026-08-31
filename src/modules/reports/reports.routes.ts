import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './reports.controller.js';

export const dashboardRoutes = Router();

dashboardRoutes.get('/', requirePermission('asset:read'), asyncHandler(controller.dashboard));

dashboardRoutes.get(
  '/warranties',
  requirePermission('asset:read'),
  validate({ query: strictObject({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  asyncHandler(controller.warranties),
);

dashboardRoutes.get(
  '/history',
  requirePermission('asset:read'),
  validate({ query: strictObject({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  asyncHandler(controller.history),
);

dashboardRoutes.post('/rebuild', requirePermission('settings:manage'), asyncHandler(controller.rebuild));

/** Mounted under /people/:id — offboarding is something you do to a person. */
export const offboardingRoutes = Router({ mergeParams: true });

offboardingRoutes.get(
  '/offboarding',
  requirePermission('person:read'),
  validate({ params: strictObject({ id: idSchema }) }),
  asyncHandler(controller.checklist),
);

offboardingRoutes.post(
  '/offboarding/start',
  requirePermission('person:deactivate'),
  validate({ params: strictObject({ id: idSchema }) }),
  asyncHandler(controller.start),
);

offboardingRoutes.post(
  '/offboarding/complete',
  requirePermission('person:deactivate'),
  validate({
    params: strictObject({ id: idSchema }),
    // Forcing completion with items outstanding is deliberate and recorded.
    body: strictObject({ force: z.boolean().optional() }),
  }),
  asyncHandler(controller.complete),
);
