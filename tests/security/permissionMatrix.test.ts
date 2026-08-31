import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { useSharedFixtures } from '../setup.js';
import {
  ensurePlansSeeded,
  seedTenant,
  seedMember,
  type SeededTenant,
  type SeededMember,
} from '../helpers/factories.js';
import { collectRoutes, fillParams, type RouteEntry } from '../helpers/routeTable.js';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../src/core/authz/index.js';

/**
 * Every route × every role.
 *
 * GENERATED from the route table and the permission registry, so it stays
 * complete as the codebase grows. A hand-written matrix covers whatever someone
 * remembered on the day and silently rots afterwards.
 *
 * The assertion is deliberately one-sided per cell:
 *
 *   role LACKS the permission  → must be exactly 403
 *   role HAS the permission    → must NOT be 403
 *
 * "Not 403" rather than "200" because a permitted request can still legitimately
 * 404 (a made-up id), 422 (an empty body) or 409 (a guard like last-owner). What
 * matters is that authorisation was not the thing that stopped it.
 */

const app = createApp();
const server = useTestServer(app);

const ROLE_KEYS = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];

// Only routes gated on a permission. requireAuth() and markPublic() routes are
// covered by routeGuards.test.ts.
const routes = collectRoutes(app).filter((r) => r.guard?.permission !== undefined);

let owner: SeededTenant;
const members: Record<string, SeededMember> = {};

/**
 * Read-only by construction: every request here is expected to be rejected or
 * to fail on something other than authorisation, so the fixtures survive.
 */
useSharedFixtures();

beforeAll(async () => {
  await ensurePlansSeeded();
  owner = await seedTenant(server(), 'matrix');

  for (const roleKey of ROLE_KEYS) {
    if (roleKey === 'owner') continue; // the seeded tenant owner already is one
    members[roleKey] = await seedMember(server(), owner, roleKey);
  }
}, 60_000);

function tokenFor(roleKey: SystemRoleKey): string {
  return roleKey === 'owner' ? owner.accessToken : members[roleKey]!.accessToken;
}

function call(route: RouteEntry, token: string): request.Test {
  // A syntactically valid id that belongs to nothing. Authorisation is checked
  // before the record is looked up, so a permitted role reaches the 404 and a
  // forbidden one never gets that far.
  const path = fillParams(route.path, '000000000000000000000000');
  const method = route.method.toLowerCase() as 'get';

  return request(server())[method](path).set('Authorization', `Bearer ${token}`).send({});
}

describe('permission matrix', () => {
  it('has routes and roles to check', () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(ROLE_KEYS).toEqual(['owner', 'admin', 'manager', 'member']);
  });

  const cells = routes.flatMap((route) =>
    ROLE_KEYS.map((roleKey) => {
      const permission = route.guard!.permission!;
      const granted = (SYSTEM_ROLES[roleKey].permissions as readonly string[]).includes(permission);
      return [`${roleKey} → ${route.method} ${route.path}`, route, roleKey, granted] as const;
    }),
  );

  it.each(cells)('%s', async (_label, route, roleKey, granted) => {
    const res = await call(route, tokenFor(roleKey));

    if (granted) {
      expect(
        res.status,
        `${roleKey} holds ${route.guard!.permission} but ${route.method} ${route.path} ` +
          `returned 403. The guard and the role definition disagree.`,
      ).not.toBe(403);
      return;
    }

    expect(
      res.status,
      `${roleKey} does NOT hold ${route.guard!.permission}, yet ${route.method} ` +
        `${route.path} returned ${res.status}. Every route must refuse a role that ` +
        'lacks its permission.',
    ).toBe(403);
  });
});

describe('the role definitions themselves', () => {
  it('gives the Owner every permission there is', async () => {
    const { ALL_PERMISSIONS } = await import('../../src/core/authz/index.js');

    // Spread rather than listed, so an Owner cannot silently lack a permission
    // added in a later release.
    expect([...SYSTEM_ROLES.owner.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('withholds billing and ownership from an Admin', () => {
    const admin = SYSTEM_ROLES.admin.permissions as readonly string[];

    for (const permission of ['billing:manage', 'tenant:transfer', 'tenant:delete']) {
      expect(admin, `An Admin must not hold ${permission}.`).not.toContain(permission);
    }
  });

  it('gives a Manager no destructive or configuration rights', () => {
    const manager = SYSTEM_ROLES.manager.permissions as readonly string[];

    for (const permission of [
      'asset:delete',
      'settings:manage',
      'customField:manage',
      'role:manage',
      'member:manage',
      'audit:read',
    ]) {
      expect(manager, `A Manager must not hold ${permission}.`).not.toContain(permission);
    }
  });

  it('gives a Member read access and nothing else', () => {
    const member = SYSTEM_ROLES.member.permissions as readonly string[];

    // The lowest role is the one whose surface must stay smallest — it is the
    // one most people in an organisation will have.
    expect(member).toEqual(['asset:read']);
  });

  it('orders the roles so each is a subset of the one above', () => {
    const owner = new Set(SYSTEM_ROLES.owner.permissions as readonly string[]);
    const admin = new Set(SYSTEM_ROLES.admin.permissions as readonly string[]);
    const manager = SYSTEM_ROLES.manager.permissions as readonly string[];
    const member = SYSTEM_ROLES.member.permissions as readonly string[];

    // Not a formal requirement, but a surprising inversion — a Manager able to
    // do something an Admin cannot — would almost certainly be a mistake.
    for (const permission of admin) {
      expect(owner, `Admin holds ${permission} but Owner does not.`).toContain(permission);
    }
    for (const permission of manager) {
      expect([...admin], `Manager holds ${permission} but Admin does not.`).toContain(permission);
    }
    for (const permission of member) {
      expect(manager, `Member holds ${permission} but Manager does not.`).toContain(permission);
    }
  });
});
