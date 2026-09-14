import { Router } from 'express';
import { asyncHandler, limits } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission, markPublic } from '../../core/authz/index.js';
import * as controller from './assignment.controller.js';
import {
  assignSchema,
  returnSchema,
  transferSchema,
  listAssignmentsSchema,
  acknowledgeSchema,
  assignmentIdSchema,
  personIdSchema,
} from './assignment.schema.js';

/**
 * Mounted under /assets/:id — assigning is an action on an asset.
 *
 * These live in the assignments module rather than the assets module even
 * though their paths sit under /assets. Assignments already depend on assets
 * (they write the cached pointer); putting the reverse dependency in the asset
 * module would create a cycle, which dependency-cruiser rejects and which is
 * what makes a modular monolith stop being modular (ADR-008).
 */
export const assetAssignmentRoutes = Router({ mergeParams: true });

assetAssignmentRoutes.get(
  '/assignments',
  requirePermission('asset:read'),
  validate(personIdSchema),
  asyncHandler(controller.history),
);

assetAssignmentRoutes.post(
  '/assign',
  requirePermission('asset:assign'),
  validate(assignSchema),
  asyncHandler(controller.assign),
);

assetAssignmentRoutes.post(
  '/return',
  requirePermission('asset:assign'),
  validate(returnSchema),
  asyncHandler(controller.unassign),
);

// One atomic operation, not a return followed by an assign — see the service.
assetAssignmentRoutes.post(
  '/transfer',
  requirePermission('asset:assign'),
  validate(transferSchema),
  asyncHandler(controller.transfer),
);

export const assignmentRoutes = Router();

assignmentRoutes.get(
  '/',
  requirePermission('asset:read'),
  validate(listAssignmentsSchema),
  asyncHandler(controller.index),
);

/**
 * Confirming receipt is public. The person confirming is usually someone who
 * was handed a laptop and has no login at all; the single-use link emailed to
 * them is what proves they are the right person. Rate limited like every other
 * endpoint that accepts a credential.
 */
assignmentRoutes.post(
  '/acknowledge/preview',
  limits.credentials,
  markPublic(),
  validate(acknowledgeSchema),
  asyncHandler(controller.acknowledgementPreview),
);

assignmentRoutes.post(
  '/acknowledge',
  limits.credentials,
  markPublic(),
  validate(acknowledgeSchema),
  asyncHandler(controller.acknowledge),
);

assignmentRoutes.post(
  '/:id/remind',
  limits.invitations,
  requirePermission('asset:assign'),
  validate(assignmentIdSchema),
  asyncHandler(controller.remind),
);
