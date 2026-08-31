import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requireAuth } from '../../core/authz/index.js';
import * as controller from './notification.controller.js';

export const notificationRoutes = Router();

/**
 * Authenticated, but no permission required.
 *
 * A notification inbox is inherently the actor's own — every query is scoped to
 * their membership id — so gating it behind a permission would only stop people
 * reading their own messages.
 */
notificationRoutes.get(
  '/',
  requireAuth(),
  validate({
    query: strictObject({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      unreadOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    }),
  }),
  asyncHandler(controller.index),
);

notificationRoutes.post(
  '/read',
  requireAuth(),
  validate({ body: strictObject({ ids: z.array(idSchema).min(1).max(200) }) }),
  asyncHandler(controller.markRead),
);

notificationRoutes.post('/read-all', requireAuth(), asyncHandler(controller.markAllRead));
