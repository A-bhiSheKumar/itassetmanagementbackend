import { Router } from 'express';
import { asyncHandler } from '../../core/http/index.js';
import { requirePermission } from '../../core/authz/index.js';
import { index, catalogue } from './role.controller.js';

export const roleRoutes = Router();

roleRoutes.get('/', requirePermission('role:read'), asyncHandler(index));
roleRoutes.get('/permissions', requirePermission('role:read'), asyncHandler(async (_r, res) => catalogue(_r, res)));
