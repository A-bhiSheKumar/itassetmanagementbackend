import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import { limits } from '../../core/http/index.js';
import * as controller from './import.controller.js';
import {
  createImportSchema,
  targetsSchema,
  mappingSchema,
  importIdSchema,
  rowsSchema,
  entityTypeParamSchema,
  exportSchema,
} from './import.schema.js';

export const importRoutes = Router();

// Static paths before /:id, or "templates" is read as an import id.
importRoutes.get(
  '/templates/:entityType',
  requirePermission('import:run'),
  validate(entityTypeParamSchema),
  controller.template,
);

importRoutes.get(
  '/targets',
  requirePermission('import:run'),
  validate(targetsSchema),
  asyncHandler(controller.targets),
);

importRoutes.get('/', requirePermission('import:run'), asyncHandler(controller.index));

// Parsing and staging a file is expensive to serve, so it gets its own budget
// on top of the standing per-tenant limit.
importRoutes.post(
  '/',
  limits.heavy,
  requirePermission('import:run'),
  validate(createImportSchema),
  asyncHandler(controller.create),
);

importRoutes.get('/:id', requirePermission('import:run'), validate(importIdSchema), asyncHandler(controller.show));

importRoutes.patch(
  '/:id/mapping',
  requirePermission('import:run'),
  validate(mappingSchema),
  asyncHandler(controller.mapping),
);

importRoutes.post(
  '/:id/validate',
  requirePermission('import:run'),
  validate(importIdSchema),
  asyncHandler(controller.validate),
);

importRoutes.post(
  '/:id/commit',
  requirePermission('import:run'),
  validate(importIdSchema),
  asyncHandler(controller.commit),
);

importRoutes.post(
  '/:id/cancel',
  requirePermission('import:run'),
  validate(importIdSchema),
  asyncHandler(controller.cancel),
);

importRoutes.get('/:id/rows', requirePermission('import:run'), validate(rowsSchema), asyncHandler(controller.rows));

importRoutes.get(
  '/:id/errors.csv',
  requirePermission('import:run'),
  validate(importIdSchema),
  asyncHandler(controller.errorFile),
);

export const exportRoutes = Router();

exportRoutes.get(
  '/:entityType',
  limits.heavy,
  requirePermission('export:run'),
  validate(exportSchema),
  asyncHandler(controller.exportEntities),
);
