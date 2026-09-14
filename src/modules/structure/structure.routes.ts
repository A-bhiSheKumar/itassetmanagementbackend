import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import type { OrgUnitKind } from '../people/index.js';
import { orgUnitController } from './structure.controller.js';
import {
  createOrgUnitSchema,
  updateOrgUnitSchema,
  createLocationSchema,
  updateLocationSchema,
  unitIdSchema,
  moveContentsSchema,
} from './structure.schema.js';

/**
 * Departments, locations and cost centres share one route shape.
 *
 * Built from a factory rather than copied three times: three near-identical
 * files drift, and the one that drifts is the one nobody re-reads.
 */
function orgUnitRouter(kind: OrgUnitKind, schemas: { create: never; update: never }): Router {
  const router = Router();
  const handlers = orgUnitController(kind);

  router.get('/', requirePermission('person:read'), asyncHandler(handlers.index));
  router.post('/', requirePermission('settings:manage'), validate(schemas.create), asyncHandler(handlers.create));
  router.patch('/:id', requirePermission('settings:manage'), validate(schemas.update), asyncHandler(handlers.update));
  router.delete('/:id', requirePermission('settings:manage'), validate(unitIdSchema), asyncHandler(handlers.destroy));
  router.post(
    '/:id/move-contents',
    requirePermission('settings:manage'),
    validate(moveContentsSchema),
    asyncHandler(handlers.moveContents),
  );

  return router;
}

export const departmentRoutes = orgUnitRouter('department', {
  create: createOrgUnitSchema as never,
  update: updateOrgUnitSchema as never,
});

export const locationRoutes = orgUnitRouter('location', {
  create: createLocationSchema as never,
  update: updateLocationSchema as never,
});

export const costCentreRoutes = orgUnitRouter('costCentre', {
  create: createOrgUnitSchema as never,
  update: updateOrgUnitSchema as never,
});
