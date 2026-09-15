import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import * as controller from './vendor.controller.js';
import { listVendorsSchema, createVendorSchema, updateVendorSchema, vendorIdSchema } from './vendor.schema.js';

export const vendorRoutes = Router();

vendorRoutes.get('/', requirePermission('vendor:read'), validate(listVendorsSchema), asyncHandler(controller.index));
vendorRoutes.post('/', requirePermission('vendor:manage'), validate(createVendorSchema), asyncHandler(controller.create));
vendorRoutes.get('/:id', requirePermission('vendor:read'), validate(vendorIdSchema), asyncHandler(controller.show));
vendorRoutes.patch('/:id', requirePermission('vendor:manage'), validate(updateVendorSchema), asyncHandler(controller.update));
vendorRoutes.delete('/:id', requirePermission('vendor:manage'), validate(vendorIdSchema), asyncHandler(controller.destroy));
