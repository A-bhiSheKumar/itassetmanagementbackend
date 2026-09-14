import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { markPublic } from '../../core/authz/index.js';
import { resendWebhook } from './webhook.js';

export const emailWebhookRoutes = Router();

/**
 * Public by necessity: Resend has no session. Authorised by the Svix signature
 * over the raw body instead, which is checked before anything is read.
 */
emailWebhookRoutes.post('/resend', markPublic(), asyncHandler(resendWebhook));
