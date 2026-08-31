import { Router } from 'express';
import { healthRoutes } from './modules/health/index.js';
import { authRoutes, meRoutes } from './modules/identity/index.js';
import { tenantRoutes } from './modules/tenants/index.js';
import { membershipRoutes } from './modules/memberships/index.js';
import { roleRoutes } from './modules/roles/index.js';
import {
  peopleRoutes,
  departmentRoutes,
  locationRoutes,
  costCentreRoutes,
} from './modules/people/index.js';
import { catalogRoutes } from './modules/catalog/index.js';
import { assetRoutes } from './modules/assets/index.js';
import { assetAssignmentRoutes, assignmentRoutes } from './modules/assignments/index.js';
import { auditLogRoutes } from './modules/auditlog/index.js';
import { documentRoutes } from './modules/documents/index.js';
import { notificationRoutes } from './modules/notifications/index.js';
import { dashboardRoutes, offboardingRoutes } from './modules/reports/index.js';

/**
 * The route table.
 *
 * Two CI-enforced suites are generated from this by walking the Express router
 * stack (tests/helpers/routeTable.ts):
 *
 *   - the guard test: every route must declare a permission, requireAuth() or
 *     markPublic(). A route that declares none fails the build, so an endpoint
 *     cannot ship unguarded by omission.
 *   - the tenant isolation test: tenant A's credentials cannot reach tenant B's
 *     records through any registered route.
 *
 * That generation is the point. A hand-maintained isolation suite is one
 * forgotten pull request away from being a false sense of security.
 */
export const apiRouter = Router();

apiRouter.use('/health', healthRoutes);
apiRouter.use('/auth', authRoutes);
apiRouter.use('/me', meRoutes);
apiRouter.use('/tenant', tenantRoutes);
apiRouter.use('/members', membershipRoutes);
apiRouter.use('/roles', roleRoutes);

// Offboarding mounts under a person, and before the people router so
// /people/:id/offboarding resolves ahead of /people/:id.
apiRouter.use('/people/:id', offboardingRoutes);
apiRouter.use('/people', peopleRoutes);
apiRouter.use('/departments', departmentRoutes);
apiRouter.use('/locations', locationRoutes);
apiRouter.use('/cost-centres', costCentreRoutes);

// Asset types, categories, custom fields and lifecycle share one module and one
// mount, because they are one concern: what an asset IS in this tenant.
apiRouter.use('/catalog', catalogRoutes);

// Assignment actions mount UNDER an asset, because assigning is something you
// do to an asset — not a separate resource you create. Mounted before the
// asset router so /assets/:id/assign resolves before /assets/:id.
apiRouter.use('/assets/:id', assetAssignmentRoutes);
apiRouter.use('/assets', assetRoutes);
apiRouter.use('/assignments', assignmentRoutes);
apiRouter.use('/audit-logs', auditLogRoutes);
apiRouter.use('/documents', documentRoutes);
apiRouter.use('/notifications', notificationRoutes);
apiRouter.use('/dashboard', dashboardRoutes);
