import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { REFRESH_COOKIE } from '../../src/core/auth/index.js';

const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);
const PASSWORD = 'correct-horse-battery-staple';

let acme: SeededTenant;

beforeEach(async () => {
  await ensurePlansSeeded();
  acme = await seedTenant(server(), 'acme');
});

function refreshCookie(res: request.Response): string {
  const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  return cookies.find((c) => c.startsWith(REFRESH_COOKIE)) ?? '';
}

describe('registration', () => {
  it('creates a user, an organisation and an owner membership in one flow', async () => {
    const res = await request(server()).post('/api/v1/auth/register').send({
      email: `new-${ulid()}@example.test`,
      password: PASSWORD,
      name: 'Dana Okafor',
      organisationName: 'Northwind Ltd',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.tenant.slug).toBe('northwind-ltd');
    expect(res.body.data.accessToken).toBeTruthy();

    // A tenant-scoped token straight away: a new signup should land in their
    // organisation, not on a chooser with one option.
    const members = await request(server())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(members.status).toBe(200);
    expect(members.body.data).toHaveLength(1);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const res = await request(server()).post('/api/v1/auth/register').send({
      email: acme.email.toUpperCase(),
      password: PASSWORD,
      name: 'Impostor',
      organisationName: 'Other Ltd',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('rejects a short password', async () => {
    const res = await request(server()).post('/api/v1/auth/register').send({
      email: `short-${ulid()}@example.test`,
      password: 'tooshort',
      name: 'A',
      organisationName: 'B',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.fields.password).toBeDefined();
  });

  it('rejects unknown fields rather than silently ignoring them', async () => {
    // Mass assignment: strict schemas mean an injected privilege field is a
    // validation error, not a quietly accepted one.
    const res = await request(server()).post('/api/v1/auth/register').send({
      email: `mass-${ulid()}@example.test`,
      password: PASSWORD,
      name: 'A',
      organisationName: 'B',
      tokenVersion: 99,
      status: 'admin',
    });

    expect(res.status).toBe(422);
  });

  it('seeds the four system roles into the new tenant', async () => {
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    expect(roles.status).toBe(200);
    expect(roles.body.data.map((r: { key: string }) => r.key).sort()).toEqual([
      'admin',
      'manager',
      'member',
      'owner',
    ]);
  });
});

describe('login', () => {
  it('returns a user token and the list of organisations', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.organisations).toHaveLength(1);
    expect(refreshCookie(res)).toContain('HttpOnly');
  });

  it('answers identically for an unknown email and a wrong password', async () => {
    // Anything that distinguishes these turns login into a user-enumeration
    // oracle, which is step one of every credential-stuffing campaign.
    const unknown = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: `nobody-${ulid()}@example.test`, password: PASSWORD });

    const wrong = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: 'definitely-not-the-password' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('sets the refresh cookie with the right protections', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: PASSWORD });

    const cookie = refreshCookie(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/auth');
  });
});

describe('refresh token rotation', () => {
  it('rotates on every refresh', async () => {
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: PASSWORD });

    const first = refreshCookie(login);

    const refreshed = await request(server()).post('/api/v1/auth/refresh').set('Cookie', first);

    expect(refreshed.status).toBe(200);
    expect(refreshCookie(refreshed)).not.toBe(first);
  });

  it('detects reuse and revokes the entire family', async () => {
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: PASSWORD });

    const stolen = refreshCookie(login);

    // The legitimate client refreshes.
    const rotated = await request(server()).post('/api/v1/auth/refresh').set('Cookie', stolen);
    expect(rotated.status).toBe(200);
    const current = refreshCookie(rotated);

    // An attacker replays the token they captured earlier.
    const replay = await request(server()).post('/api/v1/auth/refresh').set('Cookie', stolen);
    expect(replay.status).toBe(401);

    // …and the legitimate client's current token is revoked too. Signing the
    // real user out once beats leaving an attacker a valid 30-day session.
    const afterBreach = await request(server()).post('/api/v1/auth/refresh').set('Cookie', current);
    expect(afterBreach.status).toBe(401);
  });

  it('rejects a refresh with no cookie', async () => {
    const res = await request(server()).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('invalidates the token on logout', async () => {
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: acme.email, password: PASSWORD });

    const cookie = refreshCookie(login);

    await request(server()).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);

    const res = await request(server()).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});

describe('the M1 gate: one user, two organisations', () => {
  it('lets a user belong to two organisations and switch between them', async () => {
    const second = await request(server()).post('/api/v1/auth/register').send({
      email: `dual-${ulid()}@example.test`,
      password: PASSWORD,
      name: 'Dual Owner',
      organisationName: 'Second Ltd',
    });

    const email = JSON.parse(JSON.stringify(second.body.data.user)).email as string;

    // Invite the same person into Acme.
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const adminRoleId = roles.body.data.find((r: { key: string }) => r.key === 'admin').id;

    const invite = await request(server())
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ email, roleIds: [adminRoleId] });

    expect(invite.status).toBe(201);

    const accepted = await request(server())
      .post('/api/v1/auth/accept-invitation')
      .send({ token: invite.body.data.inviteToken });

    expect(accepted.status).toBe(200);

    // One login, two organisations — no duplicate user account.
    const login = await request(server()).post('/api/v1/auth/login').send({ email, password: PASSWORD });

    expect(login.body.data.organisations).toHaveLength(2);

    // Switching is a token exchange, not a re-login.
    const switched = await request(server())
      .post('/api/v1/auth/select-tenant')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ tenantId: acme.tenantId });

    expect(switched.status).toBe(200);

    const members = await request(server())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${switched.body.data.accessToken}`);

    expect(members.status).toBe(200);
    expect(members.body.data).toHaveLength(2);
  });
});

describe('authorization invariants', () => {
  it('refuses to grant a role the actor does not hold', async () => {
    // Privilege escalation: an Admin inviting someone as Owner would let them
    // promote themselves through a proxy, making every other check decorative.
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const adminRoleId = roles.body.data.find((r: { key: string }) => r.key === 'admin').id;
    const ownerRoleId = roles.body.data.find((r: { key: string }) => r.key === 'owner').id;

    const adminEmail = `admin-${ulid()}@example.test`;
    const invite = await request(server())
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ email: adminEmail, roleIds: [adminRoleId] });

    await request(server()).post('/api/v1/auth/accept-invitation').send({
      token: invite.body.data.inviteToken,
      password: PASSWORD,
      name: 'The Admin',
    });

    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD });

    const selected = await request(server())
      .post('/api/v1/auth/select-tenant')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ tenantId: acme.tenantId });

    const escalation = await request(server())
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${selected.body.data.accessToken}`)
      .send({ email: `pawn-${ulid()}@example.test`, roleIds: [ownerRoleId] });

    expect(escalation.status).toBe(403);
    expect(escalation.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('will not demote the last owner', async () => {
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const adminRoleId = roles.body.data.find((r: { key: string }) => r.key === 'admin').id;

    const res = await request(server())
      .patch(`/api/v1/members/${acme.membershipId}/roles`)
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ roleIds: [adminRoleId] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });

  it('will not suspend the last owner', async () => {
    const res = await request(server())
      .post(`/api/v1/members/${acme.membershipId}/suspend`)
      .set('Authorization', `Bearer ${acme.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });

  it('refuses a Member the permissions of an Admin', async () => {
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const memberRoleId = roles.body.data.find((r: { key: string }) => r.key === 'member').id;
    const email = `plain-${ulid()}@example.test`;

    const invite = await request(server())
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ email, roleIds: [memberRoleId] });

    await request(server()).post('/api/v1/auth/accept-invitation').send({
      token: invite.body.data.inviteToken,
      password: PASSWORD,
      name: 'Plain Member',
    });

    const login = await request(server()).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const selected = await request(server())
      .post('/api/v1/auth/select-tenant')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ tenantId: acme.tenantId });

    const token = selected.body.data.accessToken;

    await request(server()).get('/api/v1/members').set('Authorization', `Bearer ${token}`).expect(403);
    await request(server()).patch('/api/v1/tenant').set('Authorization', `Bearer ${token}`).send({ name: 'Hijacked' }).expect(403);
    await request(server()).get('/api/v1/tenant/usage').set('Authorization', `Bearer ${token}`).expect(403);
  });
});

describe('entitlement enforcement', () => {
  it('blocks an invitation once the seat limit is reached', async () => {
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const memberRoleId = roles.body.data.find((r: { key: string }) => r.key === 'member').id;

    // Starter allows 5 seats and the owner already holds one.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(server())
        .post('/api/v1/members/invite')
        .set('Authorization', `Bearer ${acme.accessToken}`)
        .send({ email: `seat${i}-${ulid()}@example.test`, roleIds: [memberRoleId] });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(4);

    const blocked = statuses.filter((s) => s === 402);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('reports usage against the plan', async () => {
    const res = await request(server())
      .get('/api/v1/tenant/usage')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.planKey).toBe('starter');
    expect(res.body.data.entitlements.assets).toBe(250);
    expect(res.body.data.usage.seats).toBe(1);
  });
});

describe('permission changes take effect immediately', () => {
  it('invalidates an outstanding token when roles change', async () => {
    const roles = await request(server())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const adminRoleId = roles.body.data.find((r: { key: string }) => r.key === 'admin').id;
    const memberRoleId = roles.body.data.find((r: { key: string }) => r.key === 'member').id;
    const email = `demoted-${ulid()}@example.test`;

    const invite = await request(server())
      .post('/api/v1/members/invite')
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ email, roleIds: [adminRoleId] });

    const accepted = await request(server()).post('/api/v1/auth/accept-invitation').send({
      token: invite.body.data.inviteToken,
      password: PASSWORD,
      name: 'Soon Demoted',
    });

    const selected = await request(server())
      .post('/api/v1/auth/select-tenant')
      .set('Authorization', `Bearer ${accepted.body.data.accessToken}`)
      .send({ tenantId: acme.tenantId });

    const token = selected.body.data.accessToken;

    await request(server()).get('/api/v1/members').set('Authorization', `Bearer ${token}`).expect(200);

    const members = await request(server())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${acme.accessToken}`);

    const targetId = members.body.data.find(
      (m: { userId: string }) => m.userId === accepted.body.data.user.id,
    ).id;

    await request(server())
      .patch(`/api/v1/members/${targetId}/roles`)
      .set('Authorization', `Bearer ${acme.accessToken}`)
      .send({ roleIds: [memberRoleId] })
      .expect(200);

    // The old token still carries admin permissions in its claims — but the
    // permVersion no longer matches, so it is refused rather than trusted.
    const after = await request(server()).get('/api/v1/members').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});
