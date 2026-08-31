import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { seedPlans } from '../../src/modules/subscriptions/index.js';
import { runAsSystem } from '../../src/core/context/index.js';

/**
 * Test factories that go through the real API.
 *
 * Deliberately not inserting documents directly: a fixture built by the same
 * code path as production cannot drift from it, and it exercises the signup
 * flow on every test run.
 */

export interface SeededTenant {
  tenantId: string;
  userId: string;
  email: string;
  password: string;
  /** Tenant-scoped access token, ready for an Authorization header. */
  accessToken: string;
  membershipId: string;
  refreshCookie: string;
}

export async function ensurePlansSeeded(): Promise<void> {
  // Plans are global reference data; seeding needs no tenant context.
  await runAsSystem({ requestId: ulid() }, () => seedPlans());
}

export async function seedTenant(app: Server, label: string): Promise<SeededTenant> {
  const email = `${label}-${ulid().toLowerCase()}@example.test`;
  const password = 'correct-horse-battery-staple';

  const res = await request(app).post('/api/v1/auth/register').send({
    email,
    password,
    name: `${label} Owner`,
    organisationName: `${label} Ltd`,
  });

  if (res.status !== 201) {
    throw new Error(`Failed to seed tenant ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }

  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;

  const members = await request(app)
    .get('/api/v1/members')
    .set('Authorization', `Bearer ${res.body.data.accessToken}`);

  // Fail here rather than returning an empty membershipId — a blank id turns
  // every downstream assertion into a confusing 404 or 500 and hides the cause.
  if (members.status !== 200 || !members.body.data?.[0]?.id) {
    throw new Error(
      `Failed to read members for ${label}: ${members.status} ${JSON.stringify(members.body)}`,
    );
  }

  return {
    tenantId: res.body.data.tenant.id,
    userId: res.body.data.user.id,
    email,
    password,
    accessToken: res.body.data.accessToken,
    membershipId: members.body.data[0].id,
    refreshCookie: cookies?.[0] ?? '',
  };
}

export function auth(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

export interface SeededMember {
  membershipId: string;
  userId: string;
  email: string;
  /** Tenant-scoped access token for this role. */
  accessToken: string;
  roleKey: string;
}

/**
 * Adds a member with a given system role and signs them in.
 *
 * Goes through invite → accept → login → select-tenant, the real flow, so the
 * resulting token carries exactly the permissions a real member of that role
 * would have — not a hand-assembled set that could drift from production.
 */
export async function seedMember(
  app: Server,
  owner: SeededTenant,
  roleKey: 'owner' | 'admin' | 'manager' | 'member',
): Promise<SeededMember> {
  const password = 'correct-horse-battery-staple';
  const email = `${roleKey}-${ulid().toLowerCase()}@example.test`;

  const roles = await request(app)
    .get('/api/v1/roles')
    .set('Authorization', `Bearer ${owner.accessToken}`);

  const role = roles.body.data.find((r: { key: string }) => r.key === roleKey);
  if (!role) throw new Error(`No system role "${roleKey}" in this tenant.`);

  const invite = await request(app)
    .post('/api/v1/members/invite')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ email, roleIds: [role.id] });

  if (invite.status !== 201) {
    throw new Error(`Failed to invite ${roleKey}: ${invite.status} ${JSON.stringify(invite.body)}`);
  }

  const accepted = await request(app).post('/api/v1/auth/accept-invitation').send({
    token: invite.body.data.inviteToken,
    password,
    name: `${roleKey} member`,
  });

  const selected = await request(app)
    .post('/api/v1/auth/select-tenant')
    .set('Authorization', `Bearer ${accepted.body.data.accessToken}`)
    .send({ tenantId: owner.tenantId });

  if (selected.status !== 200) {
    throw new Error(`Failed to select tenant as ${roleKey}: ${selected.status}`);
  }

  const members = await request(app)
    .get('/api/v1/members')
    .set('Authorization', `Bearer ${owner.accessToken}`);

  const membership = members.body.data.find(
    (m: { userId: string }) => m.userId === accepted.body.data.user.id,
  );

  return {
    membershipId: membership?.id ?? '',
    userId: accepted.body.data.user.id,
    email,
    accessToken: selected.body.data.accessToken,
    roleKey,
  };
}

/**
 * Raises a tenant's plan limits.
 *
 * Uses the real `entitlementOverrides` mechanism — the same one that grants a
 * customer extra headroom while they migrate — rather than reaching past the
 * entitlement system, so the limit check under test is the production one.
 */
export async function raiseLimits(
  tenantId: string,
  overrides: Record<string, number | null>,
): Promise<void> {
  const { SubscriptionModel } = await import('../../src/modules/subscriptions/index.js');

  await SubscriptionModel.collection.updateOne(
    { tenantId },
    { $set: { entitlementOverrides: overrides } },
  );
}
