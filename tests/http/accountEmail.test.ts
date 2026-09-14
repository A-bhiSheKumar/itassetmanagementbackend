import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { emailedToken } from '../helpers/email.js';
import { EmailMessageModel, recordingTransport } from '../../src/modules/email/index.js';
import { runAsSystem } from '../../src/core/context/index.js';
import { env } from '../../src/config/index.js';

const app = createApp();
const server = useTestServer(app);
let t: SeededTenant;
let adminRoleId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

const newAddress = (label: string) => `${label}-${ulid().toLowerCase()}@example.test`;
const PASSWORD = 'a-brand-new-long-password';

beforeEach(async () => {
  await ensurePlansSeeded();
  recordingTransport().clear();
  t = await seedTenant(server(), 'mail');
  const roles = await as(request(server()).get('/api/v1/roles'));
  adminRoleId = roles.body.data.find((r: { key: string }) => r.key === 'admin').id;
});

/** Email log rows are global; reading them in a test needs no tenant. */
const emailLog = (filter: Record<string, unknown>) =>
  runAsSystem({ requestId: 'test' }, () => EmailMessageModel.find(filter).lean());

describe('invitations', () => {
  it('are emailed with a working link, and the API never returns the token', async () => {
    const email = newAddress('invitee');
    const invite = await as(request(server()).post('/api/v1/members/invite').send({ email, roleIds: [adminRoleId] })).expect(201);

    expect(JSON.stringify(invite.body)).not.toMatch(/token/i);

    const [message] = recordingTransport().to(email);
    expect(message!.subject).toBe(`You're invited to mail Ltd on ${env.APP_NAME}`);
    expect(message!.text).toContain('Admin');

    const token = emailedToken(email, '/accept-invitation');
    const preview = await request(server()).post('/api/v1/auth/invitation').send({ token }).expect(200);
    expect(preview.body.data).toMatchObject({ email, organisationName: 'mail Ltd', inviterName: 'mail Owner', hasAccount: false });

    await request(server()).post('/api/v1/auth/accept-invitation').send({ token, name: 'New Admin', password: PASSWORD }).expect(200);
  });

  it('erase the link from the email log once delivered, keeping the record that it was sent', async () => {
    const email = newAddress('redacted');
    await as(request(server()).post('/api/v1/members/invite').send({ email, roleIds: [adminRoleId] })).expect(201);

    const [row] = await emailLog({ to: email });
    expect(row!.status).toBe('sent');
    expect(row!.subject).toContain('invited');
    expect(row!.html).not.toContain('token=');
    expect(row!.text).not.toContain('token=');
  });

  it('are listed while pending, with what happened to the email', async () => {
    const email = newAddress('pending');
    await as(request(server()).post('/api/v1/members/invite').send({ email, roleIds: [adminRoleId] })).expect(201);

    const list = await as(request(server()).get('/api/v1/members/invitations')).expect(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({ email, invitedByName: 'mail Owner', expired: false, emailStatus: 'sent' }),
    ]);
  });

  it('can be resent, which retires the old link', async () => {
    const email = newAddress('resend');
    const invite = await as(request(server()).post('/api/v1/members/invite').send({ email, roleIds: [adminRoleId] })).expect(201);
    const oldToken = emailedToken(email, '/accept-invitation');

    await as(request(server()).post(`/api/v1/members/invitations/${invite.body.data.id}/resend`)).expect(200);
    const newToken = emailedToken(email, '/accept-invitation');

    expect(newToken).not.toBe(oldToken);
    await request(server()).post('/api/v1/auth/invitation').send({ token: oldToken }).expect(404);
    await request(server()).post('/api/v1/auth/invitation').send({ token: newToken }).expect(200);
  });

  it('can be withdrawn, after which the link is dead', async () => {
    const email = newAddress('revoke');
    const invite = await as(request(server()).post('/api/v1/members/invite').send({ email, roleIds: [adminRoleId] })).expect(201);
    const token = emailedToken(email, '/accept-invitation');

    await as(request(server()).delete(`/api/v1/members/invitations/${invite.body.data.id}`)).expect(204);

    await request(server()).post('/api/v1/auth/accept-invitation').send({ token, name: 'Too Late', password: PASSWORD }).expect(404);
    const list = await as(request(server()).get('/api/v1/members/invitations'));
    expect(list.body.data).toEqual([]);
  });
});

describe('forgotten passwords', () => {
  it('answer the same for an unknown address, and email nobody', async () => {
    const res = await request(server()).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.test' });

    expect(res.status).toBe(202);
    expect(res.body.data.message).toContain('If that address has an account');
    expect(recordingTransport().to('nobody@example.test')).toEqual([]);
  });

  it('reset with a single-use link that signs every device out', async () => {
    const known = await request(server()).post('/api/v1/auth/forgot-password').send({ email: t.email });
    expect(known.status).toBe(202);

    const token = emailedToken(t.email, '/reset-password');
    await request(server()).post('/api/v1/auth/reset-password').send({ token, password: PASSWORD }).expect(204);

    // The new password works; the old one does not.
    await request(server()).post('/api/v1/auth/login').send({ email: t.email, password: PASSWORD }).expect(200);
    await request(server()).post('/api/v1/auth/login').send({ email: t.email, password: t.password }).expect(401);

    // The session from before the reset is gone.
    const refreshed = await request(server()).post('/api/v1/auth/refresh').set('Cookie', t.refreshCookie);
    expect(refreshed.status).toBe(401);

    // The link does not work twice.
    const again = await request(server()).post('/api/v1/auth/reset-password').send({ token, password: 'another-long-password' });
    expect(again.status).toBe(422);

    // And the owner of the account is told.
    expect(recordingTransport().to(t.email).map((m) => m.subject)).toContain(`Your ${env.APP_NAME} password was changed`);
  });

  it('send one email per minute at most, however often someone asks', async () => {
    await request(server()).post('/api/v1/auth/forgot-password').send({ email: t.email }).expect(202);
    await request(server()).post('/api/v1/auth/forgot-password').send({ email: t.email }).expect(202);

    expect(recordingTransport().to(t.email).filter((m) => m.subject.startsWith('Reset'))).toHaveLength(1);
  });
});

describe('confirming receipt', () => {
  let laptopTypeId: string;

  beforeEach(async () => {
    const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
    laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
  });

  async function setUp(personEmail: string | null) {
    const person = await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor', email: personEmail })).expect(201);
    const asset = await as(
      request(server()).post('/api/v1/assets').send({ name: 'MacBook Pro', assetTypeId: laptopTypeId, serialNumber: `SN-${ulid()}` }),
    ).expect(201);
    return { personId: person.body.data.id as string, assetId: asset.body.data.id as string };
  }

  it('is refused up front for someone with no email address', async () => {
    const { personId, assetId } = await setUp(null);
    const res = await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: personId, requireAcknowledgement: true }));

    expect(res.status).toBe(422);
    expect(res.body.error.fields.requireAcknowledgement[0]).toContain('email address');
  });

  it('works from the emailed link with no login, once, and shows on the timeline', async () => {
    const email = newAddress('holder');
    const { personId, assetId } = await setUp(email);
    const assigned = await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: personId, requireAcknowledgement: true })).expect(201);
    expect(JSON.stringify(assigned.body)).not.toMatch(/token/i);

    const token = emailedToken(email, '/confirm-receipt');

    const preview = await request(server()).post('/api/v1/assignments/acknowledge/preview').send({ token }).expect(200);
    expect(preview.body.data).toMatchObject({ organisationName: 'mail Ltd', assetName: 'MacBook Pro', confirmedAt: null, stillAssigned: true });

    const confirmed = await request(server()).post('/api/v1/assignments/acknowledge').send({ token }).expect(200);
    expect(confirmed.body.data.confirmedAt).toBeTruthy();
    // Confirming again is harmless.
    await request(server()).post('/api/v1/assignments/acknowledge').send({ token }).expect(200);

    const timeline = await as(request(server()).get(`/api/v1/assets/${assetId}/timeline`));
    expect(timeline.body.data.map((e: { summary: string }) => e.summary)).toContain('Receipt of MacBook Pro was confirmed');
  });

  it('can be chased with a reminder that replaces the link, once a day', async () => {
    const email = newAddress('slow');
    const { personId, assetId } = await setUp(email);
    const assigned = await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: personId, requireAcknowledgement: true })).expect(201);
    const first = emailedToken(email, '/confirm-receipt');

    const reminded = await as(request(server()).post(`/api/v1/assignments/${assigned.body.data.id}/remind`)).expect(200);
    expect(reminded.body.data.sent).toBe('receipt');
    const second = emailedToken(email, '/confirm-receipt');

    expect(second).not.toBe(first);
    await request(server()).post('/api/v1/assignments/acknowledge/preview').send({ token: first }).expect(404);

    const again = await as(request(server()).post(`/api/v1/assignments/${assigned.body.data.id}/remind`));
    expect(again.status).toBe(422);
    expect(again.body.error.message).toContain('already reminded today');
    // The refused reminder did not break the link they have.
    await request(server()).post('/api/v1/assignments/acknowledge/preview').send({ token: second }).expect(200);
  });

  it('reminds someone to bring back what is due', async () => {
    const email = newAddress('borrower');
    const { personId, assetId } = await setUp(email);
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const assigned = await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: personId, dueAt: due })).expect(201);

    const res = await as(request(server()).post(`/api/v1/assignments/${assigned.body.data.id}/remind`)).expect(200);

    expect(res.body.data.sent).toBe('return');
    expect(recordingTransport().to(email).at(-1)!.subject).toContain('is due back on');
  });
});
