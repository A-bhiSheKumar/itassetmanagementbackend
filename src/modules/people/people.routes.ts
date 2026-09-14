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
} from './people.schema.js';

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
