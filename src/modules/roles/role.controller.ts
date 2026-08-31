import type { Request, Response } from 'express';
import { ok } from '../../core/http/index.js';
import { PERMISSIONS } from '../../core/authz/index.js';
import { listRoles } from './role.service.js';

export async function index(_req: Request, res: Response): Promise<void> {
  const roles = await listRoles();
  ok(
    res,
    roles.map((r) => ({
      id: String(r._id),
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      isSystem: r.isSystem,
      scopeType: r.scopeType,
    })),
  );
}

/**
 * The permission catalogue.
 *
 * The role editor renders from this rather than a hardcoded frontend list, so
 * a permission added to the backend registry appears in the UI automatically
 * and the two cannot drift.
 */
export function catalogue(_req: Request, res: Response): void {
  ok(
    res,
    Object.entries(PERMISSIONS).map(([key, label]) => ({
      key,
      label,
      resource: key.split(':')[0],
      action: key.split(':')[1],
    })),
  );
}
