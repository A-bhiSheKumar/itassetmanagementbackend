import { Router } from 'express';
import { markPublic } from '../../core/authz/index.js';
import { live, ready } from './health.controller.js';

export const healthRoutes = Router();

// Explicitly public. The load balancer polls these before any token exists —
// but "public" has to be a decision someone made, not a guard someone forgot,
// which is what tests/security/routeGuards.test.ts enforces.
healthRoutes.get('/live', markPublic(), live);
healthRoutes.get('/ready', markPublic(), ready);
