import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '../../src/core/context/index.js';

/**
 * Two-tenant fixture — the backbone of the isolation suite.
 *
 * Every isolation test creates parallel data in tenant A and tenant B, then
 * asserts that A's context cannot see, change or delete B's records.
 */

export interface TestTenant {
  tenantId: string;
  userId: string;
  membershipId: string;
}

export function makeTenant(label: string): TestTenant {
  return {
    tenantId: `tenant_${label}_${ulid()}`,
    userId: `user_${label}_${ulid()}`,
    membershipId: `mbr_${label}_${ulid()}`,
  };
}

export function contextFor(
  tenant: TestTenant,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: ulid(),
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    membershipId: tenant.membershipId,
    permissions: new Set<string>(),
    actorType: 'user',
    ...overrides,
  };
}

/**
 * Runs `fn` as if the request came from `tenant`.
 *
 * Awaits INSIDE the context. A Mongoose query is lazy, so returning one from
 * here unexecuted would run it after the context had already exited — see the
 * note on runWithContext().
 */
export async function asTenant<T>(tenant: TestTenant, fn: () => T | Promise<T>): Promise<T> {
  return runWithContext(contextFor(tenant), async () => fn());
}

/** Runs `fn` with a context that has a user but NO tenant — must throw. */
export async function withoutTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithContext(
    { requestId: ulid(), permissions: new Set<string>(), actorType: 'user' },
    async () => fn(),
  );
}

export interface TenantPair {
  a: TestTenant;
  b: TestTenant;
}

export function makeTenantPair(): TenantPair {
  return { a: makeTenant('a'), b: makeTenant('b') };
}
