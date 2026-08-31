import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../core/http/index.js';
import { validate } from '../../core/validation/index.js';
import { markPublic, requireAuth } from '../../core/authz/index.js';
import { isTest } from '../../config/index.js';
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
 * Disabled under test: supertest issues every request from the same address, so
 * the limiter would make test order significant.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: isTest ? 0 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
  },
});

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
