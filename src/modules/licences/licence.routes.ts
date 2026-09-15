import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './licence.controller.js';
import {
  listLicencesSchema,
  createLicenceSchema,
  updateLicenceSchema,
  licenceIdSchema,
  allocateSeatSchema,
  seatIdSchema,
} from './licence.schema.js';

export const licenceRoutes = Router();

const read = requirePermission('licence:read');
const manage = requirePermission('licence:manage');

licenceRoutes.get('/', read, validate(listLicencesSchema), asyncHandler(controller.index));
licenceRoutes.post('/', manage, validate(createLicenceSchema), asyncHandler(controller.create));
licenceRoutes.get('/:id', read, validate(licenceIdSchema), asyncHandler(controller.show));
licenceRoutes.patch('/:id', manage, validate(updateLicenceSchema), asyncHandler(controller.update));
licenceRoutes.delete('/:id', manage, validate(licenceIdSchema), asyncHandler(controller.destroy));

// POST, not GET: revealing is an action that is audited, and must never be prefetched or cached.
licenceRoutes.post('/:id/key', requirePermission('licence:reveal'), validate(licenceIdSchema), asyncHandler(controller.reveal));

licenceRoutes.get(
  '/:id/seats',
  read,
  validate({ params: strictObject({ id: idSchema }), query: strictObject({ includeRevoked: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(controller.seats),
);
licenceRoutes.post('/:id/seats', manage, validate(allocateSeatSchema), asyncHandler(controller.allocate));
licenceRoutes.delete('/:id/seats/:seatId', manage, validate(seatIdSchema), asyncHandler(controller.revoke));

/** Mounted under /people/:id — the software someone uses. */
export const personLicenceRoutes = Router({ mergeParams: true });
personLicenceRoutes.get('/licences', read, validate(licenceIdSchema), asyncHandler(controller.forPerson));
