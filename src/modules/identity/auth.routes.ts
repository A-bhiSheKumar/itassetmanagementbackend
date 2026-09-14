import { Router } from 'express';
import { asyncHandler, limits } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { markPublic, requireAuth } from '../../core/authz/index.js';
import {
  register,
  login,
  selectTenant,
  refresh,
  logout,
  acceptInvitation,
  me,
  updatePassword,
} from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  selectTenantSchema,
  acceptInvitationSchema,
  changePasswordSchema,
} from './auth.schema.js';

/**
 * Credential endpoints are rate limited far harder than the rest of the API —
 * this is where credential stuffing lands (docs/04-api-design.md §8).
 *
 * The limiter used to be express-rate-limit with its default in-memory store:
 * a count per process, which on Lambda means a count per container and barely
 * a limit at all. It now counts in MongoDB, alongside the per-account lockout
 * on the user record.
 */
const authLimiter = limits.credentials;

export const authRoutes = Router();

authRoutes.post('/register', authLimiter, markPublic(), validate(registerSchema), asyncHandler(register));
authRoutes.post('/login', authLimiter, markPublic(), validate(loginSchema), asyncHandler(login));
authRoutes.post('/refresh', markPublic(), asyncHandler(refresh));
authRoutes.post('/logout', markPublic(), asyncHandler(logout));
authRoutes.post(
  '/accept-invitation',
  authLimiter,
  markPublic(),
  validate(acceptInvitationSchema),
  asyncHandler(acceptInvitation),
);

authRoutes.post(
  '/select-tenant',
  requireAuth(),
  validate(selectTenantSchema),
  asyncHandler(selectTenant),
);

export const meRoutes = Router();

meRoutes.get('/', requireAuth(), asyncHandler(me));
meRoutes.post(
  '/change-password',
  requireAuth(),
  validate(changePasswordSchema),
  asyncHandler(updatePassword),
);
