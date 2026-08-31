import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import { index } from './auditlog.controller.js';

export const auditLogRoutes = Router();

/**
 * Read-only by construction. There is no POST, PATCH or DELETE here at any
 * role — the collection is append-only, and the absence of a route is a
 * stronger guarantee than a permission check.
 */
auditLogRoutes.get(
  '/',
  requirePermission('audit:read'),
  validate({
    query: strictObject({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      entityType: z.string().max(40).optional(),
      entityId: idSchema.optional(),
      action: z.string().max(60).optional(),
      actorId: idSchema.optional(),
      outcome: z.enum(['success', 'denied', 'error']).optional(),
    }),
  }),
  asyncHandler(index),
);
