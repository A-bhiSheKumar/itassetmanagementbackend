import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, type Permission } from '../../core/authz/index.js';
import { RoleModel, type RoleDocument } from './role.model.js';

/** Seeds the four system roles into a new tenant. Idempotent. */
export async function seedSystemRoles(): Promise<Record<string, string>> {
  const existing = await RoleModel.find({ isSystem: true }).lean();
  if (existing.length === SYSTEM_ROLE_KEYS.length) {
    return Object.fromEntries(existing.map((r) => [r.key, String(r._id)]));
  }

  const created = await RoleModel.insertMany(
    SYSTEM_ROLE_KEYS.map((key) => ({
      key,
      name: SYSTEM_ROLES[key].name,
      description: SYSTEM_ROLES[key].description,
      permissions: [...SYSTEM_ROLES[key].permissions],
      isSystem: true,
      scopeType: key === 'manager' ? 'department' : key === 'member' ? 'own' : 'all',
    })),
  );

  return Object.fromEntries(created.map((r) => [r.key, String(r._id)]));
}

/**
 * Brings this tenant's system roles up to the code's definition.
 *
 * System roles are seeded per tenant, so a permission added in a release does
 * not reach organisations created before it — an Owner would lack a feature
 * that shipped. Run by `db:sync` on deploy. Custom roles are never touched:
 * what a customer configured is theirs.
 */
export async function syncSystemRolePermissions(): Promise<string[]> {
  const roles = await RoleModel.find({ isSystem: true }).exec();
  const changed: string[] = [];

  for (const role of roles) {
    const definition = SYSTEM_ROLES[role.key as keyof typeof SYSTEM_ROLES];
    if (!definition) continue;

    const wanted = [...definition.permissions].sort();
    const current = [...role.permissions].sort();
    if (wanted.length === current.length && wanted.every((p, i) => p === current[i])) continue;

    role.permissions = wanted;
    await role.save();
    changed.push(role.key);
  }

  return changed;
}

export function listRoles(): Promise<RoleDocument[]> {
  return RoleModel.find({}).sort({ isSystem: -1, name: 1 }).exec();
}

export function findRolesByIds(ids: string[]): Promise<RoleDocument[]> {
  return RoleModel.find({ _id: { $in: ids } }).exec();
}

export async function findRoleByKey(key: string): Promise<RoleDocument | null> {
  return RoleModel.findOne({ key }).exec();
}

/** The union of permissions across a set of roles. */
export async function resolvePermissions(roleIds: string[]): Promise<Set<Permission>> {
  if (roleIds.length === 0) return new Set();

  const roles = await RoleModel.find({ _id: { $in: roleIds } })
    .select('permissions')
    .lean();

  const permissions = new Set<Permission>();
  for (const role of roles) {
    for (const p of role.permissions) permissions.add(p as Permission);
  }
  return permissions;
}

/**
 * Privilege-escalation guard (docs/02-architecture.md §5.3).
 *
 * An actor may only grant roles whose permissions are a subset of their own.
 * Without this, any Admin who can edit members can promote themselves to Owner
 * — which makes every other permission check decorative.
 */
export async function assertCanGrantRoles(
  actorPermissions: ReadonlySet<string>,
  roleIds: string[],
): Promise<void> {
  const granting = await resolvePermissions(roleIds);
  const excess = [...granting].filter((p) => !actorPermissions.has(p));

  if (excess.length > 0) {
    const { PermissionDeniedError } = await import('../../core/errors/index.js');
    throw new PermissionDeniedError(excess[0]);
  }
}
