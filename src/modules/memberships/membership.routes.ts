import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { requirePermission } from '../../core/authz/index.js';
import { limits } from '../../core/http/index.js';
import { index, invite, updateRoles, suspend, reactivate, invitations, resend, revoke } from './membership.controller.js';
import { inviteMemberSchema, updateRolesSchema, membershipIdSchema } from './membership.schema.js';

export const membershipRoutes = Router();

membershipRoutes.get('/', requirePermission('member:read'), asyncHandler(index));

// Invitations are a spam vector: the cost is our deliverability reputation,
// not our CPU, which makes it worth a much tighter limit than throughput needs.
membershipRoutes.post(
  '/invite',
  limits.invitations,
  requirePermission('member:invite'),
  validate(inviteMemberSchema),
  asyncHandler(invite),
);

membershipRoutes.get('/invitations', requirePermission('member:read'), asyncHandler(invitations));

// Resending is sending another email, so it shares the invitation limit.
membershipRoutes.post(
  '/invitations/:id/resend',
  limits.invitations,
  requirePermission('member:invite'),
  validate(membershipIdSchema),
  asyncHandler(resend),
);

membershipRoutes.delete(
  '/invitations/:id',
  requirePermission('member:invite'),
  validate(membershipIdSchema),
  asyncHandler(revoke),
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
