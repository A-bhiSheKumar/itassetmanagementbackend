/**
 * The permission registry — the single source of truth for what can be done.
 *
 * Permissions are `resource:action` strings. Nothing in the codebase compares a
 * permission literal inline: everything resolves through this registry, so the
 * full surface is enumerable, testable, and renderable in a role editor.
 *
 * Two CI-enforced suites depend on this being complete:
 *   - the permission matrix test (every route × every role)
 *   - the route table test (no route ships without a declared permission)
 */

export const PERMISSIONS = {
  // Assets
  'asset:read': 'View assets',
  'asset:create': 'Create assets',
  'asset:update': 'Edit assets',
  'asset:delete': 'Delete assets',
  'asset:assign': 'Assign and return assets',
  'asset:transition': 'Change asset lifecycle state',

  // People
  'person:read': 'View people',
  'person:create': 'Add people',
  'person:update': 'Edit people',
  'person:deactivate': 'Deactivate and offboard people',

  // Members and access
  'member:read': 'View members',
  'member:invite': 'Invite members',
  'member:manage': 'Change member roles and access',
  'role:read': 'View roles',
  'role:manage': 'Create and edit roles',

  // Configuration
  'settings:manage': 'Manage organisation settings',
  'customField:manage': 'Manage custom fields',

  // Data
  'import:run': 'Import data',
  'export:run': 'Export data',
  'audit:read': 'View the audit log',

  // Commercial
  'billing:manage': 'Manage the subscription',

  // Destructive, owner-only
  'tenant:transfer': 'Transfer ownership',
  'tenant:delete': 'Delete the organisation',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

/**
 * System role definitions, seeded into every tenant on creation.
 *
 * Deviation from docs/01 §4, decided during implementation: system roles are
 * seeded PER TENANT rather than living globally with `tenantId: null`. A global
 * role row would have to be exempt from tenant scoping, punching a hole in the
 * one mechanism the whole isolation model rests on. Four extra documents per
 * tenant is a trivially cheaper price than an exception to that rule — and it
 * makes custom roles the same shape as system roles, so the role editor in v1.2
 * needs no special cases.
 */
export const SYSTEM_ROLES = {
  owner: {
    name: 'Owner',
    description: 'Full access, including billing and ownership.',
    // Spread rather than listed: an Owner must never silently lack a permission
    // added in a later release.
    permissions: ALL_PERMISSIONS,
  },
  admin: {
    name: 'Admin',
    description: 'Full access except billing and ownership.',
    permissions: ALL_PERMISSIONS.filter(
      (p) => !['billing:manage', 'tenant:transfer', 'tenant:delete'].includes(p),
    ),
  },
  manager: {
    name: 'Manager',
    description: 'Manage assets and people within their department or location.',
    permissions: [
      'asset:read',
      'asset:create',
      'asset:update',
      'asset:assign',
      'asset:transition',
      'person:read',
      'person:update',
      'member:read',
      'export:run',
    ] as Permission[],
  },
  member: {
    name: 'Member',
    description: 'View and acknowledge their own assets.',
    permissions: ['asset:read'] as Permission[],
  },
} as const;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;

export const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];
