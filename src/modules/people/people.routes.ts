import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './people.controller.js';
import {
  listPeopleSchema,
  createPersonSchema,
  updatePersonSchema,
  personIdSchema,
  createOrgUnitSchema,
  updateOrgUnitSchema,
  createLocationSchema,
  updateLocationSchema,
} from './people.schema.js';
import type { OrgUnitKind } from './orgUnit.model.js';

export const peopleRoutes = Router();

peopleRoutes.get('/', requirePermission('person:read'), validate(listPeopleSchema), asyncHandler(controller.index));
peopleRoutes.post('/', requirePermission('person:create'), validate(createPersonSchema), asyncHandler(controller.create));
peopleRoutes.get('/:id', requirePermission('person:read'), validate(personIdSchema), asyncHandler(controller.show));
peopleRoutes.patch('/:id', requirePermission('person:update'), validate(updatePersonSchema), asyncHandler(controller.update));
peopleRoutes.post(
  '/:id/deactivate',
  requirePermission('person:deactivate'),
  validate(personIdSchema),
  asyncHandler(controller.deactivate),
);
peopleRoutes.delete('/:id', requirePermission('person:deactivate'), validate(personIdSchema), asyncHandler(controller.destroy));

/**
 * Departments, locations and cost centres share one route shape.
 *
 * Built from a factory rather than copied three times: three near-identical
 * files drift, and the one that drifts is the one nobody re-reads.
 */
function orgUnitRouter(kind: OrgUnitKind, schemas: { create: never; update: never }): Router {
  const router = Router();
  const handlers = controller.orgUnitController(kind);

  router.get('/', requirePermission('person:read'), asyncHandler(handlers.index));
  router.post('/', requirePermission('settings:manage'), validate(schemas.create), asyncHandler(handlers.create));
  router.patch('/:id', requirePermission('settings:manage'), validate(schemas.update), asyncHandler(handlers.update));
  router.delete('/:id', requirePermission('settings:manage'), validate(schemas.update), asyncHandler(handlers.destroy));

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
