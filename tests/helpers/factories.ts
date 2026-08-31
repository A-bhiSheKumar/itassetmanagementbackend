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
