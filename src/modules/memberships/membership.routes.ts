import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import { index, invite, updateRoles, suspend, reactivate } from './membership.controller.js';
import { inviteMemberSchema, updateRolesSchema, membershipIdSchema } from './membership.schema.js';

export const membershipRoutes = Router();

membershipRoutes.get('/', requirePermission('member:read'), asyncHandler(index));

membershipRoutes.post(
  '/invite',
  requirePermission('member:invite'),
  validate(inviteMemberSchema),
  asyncHandler(invite),
);

membershipRoutes.patch(
  '/:id/roles',
  requirePermission('member:manage'),
  validate(updateRolesSchema),
  asyncHandler(updateRoles),
);

membershipRoutes.post(
  '/:id/suspend',
  requirePermission('member:manage'),
  validate(membershipIdSchema),
  asyncHandler(suspend),
);

membershipRoutes.post(
  '/:id/reactivate',
  requirePermission('member:manage'),
  validate(membershipIdSchema),
  asyncHandler(reactivate),
);
