import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/index.js';
import { validate, strictObject, idSchema } from '../../core/validation/index.js';
import { requireAuth } from '../../core/authz/index.js';
import { SAVED_VIEW_MODULES } from './savedView.model.js';
import * as controller from './savedView.controller.js';

export const savedViewRoutes = Router();

/**
 * Authenticated, no permission.
 *
 * A saved view is a person's own bookmark — every query is scoped to their
 * membership — and it grants nothing: opening a view still runs the list
 * endpoint, which enforces its own permission. Gating it would only stop people
 * saving filters on screens they can already see.
 */
savedViewRoutes.get(
  '/',
  requireAuth(),
  validate({ query: strictObject({ module: z.enum(SAVED_VIEW_MODULES) }) }),
  asyncHandler(controller.index),
);

savedViewRoutes.post(
  '/',
  requireAuth(),
  validate({
    body: strictObject({
      module: z.enum(SAVED_VIEW_MODULES),
      name: z.string().trim().min(1, 'Give the view a name.').max(60),
      query: z.string().max(2000),
    }),
  }),
  asyncHandler(controller.save),
);

savedViewRoutes.delete(
  '/:id',
  requireAuth(),
  validate({ params: strictObject({ id: idSchema }) }),
  asyncHandler(controller.remove),
);
