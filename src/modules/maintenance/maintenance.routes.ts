import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './maintenance.controller.js';
import {
  listMaintenanceSchema,
  createMaintenanceSchema,
  updateMaintenanceSchema,
  startMaintenanceSchema,
  completeMaintenanceSchema,
  maintenanceIdSchema,
} from './maintenance.schema.js';

export const maintenanceRoutes = Router();

const read = requirePermission('maintenance:read');
const manage = requirePermission('maintenance:manage');

maintenanceRoutes.get('/', read, validate(listMaintenanceSchema), asyncHandler(controller.index));
maintenanceRoutes.get(
  '/costs',
  read,
  validate({ query: strictObject({ assetId: idSchema.optional(), vendorId: idSchema.optional() }) }),
  asyncHandler(controller.costs),
);
maintenanceRoutes.post('/', manage, validate(createMaintenanceSchema), asyncHandler(controller.create));
maintenanceRoutes.get('/:id', read, validate(maintenanceIdSchema), asyncHandler(controller.show));
maintenanceRoutes.patch('/:id', manage, validate(updateMaintenanceSchema), asyncHandler(controller.update));
maintenanceRoutes.post('/:id/start', manage, validate(startMaintenanceSchema), asyncHandler(controller.start));
maintenanceRoutes.post('/:id/complete', manage, validate(completeMaintenanceSchema), asyncHandler(controller.complete));
maintenanceRoutes.post('/:id/cancel', manage, validate(maintenanceIdSchema), asyncHandler(controller.cancel));
maintenanceRoutes.delete('/:id', manage, validate(maintenanceIdSchema), asyncHandler(controller.destroy));
