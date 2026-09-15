import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { runAsSystem } from '../../src/core/context/index.js';
import { LicenceModel } from '../../src/modules/licences/index.js';
import { AuditLogModel } from '../../src/modules/auditlog/index.js';

const app = createApp();
const server = useTestServer(app);
let t: SeededTenant;
let laptopTypeId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

async function vendor(name = 'Dell Technologies'): Promise<string> {
  return (await as(request(server()).post('/api/v1/vendors').send({ name, kinds: ['supplier'] })).expect(201)).body.data.id;
}

async function asset(body: Record<string, unknown> = {}): Promise<string> {
  return (
    await as(
      request(server()).post('/api/v1/assets').send({ name: 'Latitude 7440', assetTypeId: laptopTypeId, serialNumber: `SN-${ulid()}`, ...body }),
    ).expect(201)
  ).body.data.id;
}

async function person(firstName = 'Ada'): Promise<string> {
  return (await as(request(server()).post('/api/v1/people').send({ firstName, lastName: 'Okafor' })).expect(201)).body.data.id;
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'ops');
  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
});

describe('vendors', () => {
  it('are found by any word of their name, and a second one with the same name is refused', async () => {
    await vendor('Dell Technologies');
    const found = await as(request(server()).get('/api/v1/vendors?q=tech')).expect(200);
    expect(found.body.data.map((v: { name: string }) => v.name)).toEqual(['Dell Technologies']);

    const dup = await as(request(server()).post('/api/v1/vendors').send({ name: 'dell technologies' }));
    expect(dup.status).toBe(409);
  });

  it('cannot be deleted while assets were bought from them, and say how many', async () => {
    const id = await vendor();
    await asset({ purchase: { vendorId: id } });

    const res = await as(request(server()).delete(`/api/v1/vendors/${id}`));
    expect(res.status).toBe(409);
    expect(res.body.error.details.references).toContainEqual({ type: 'asset bought from them', count: 1 });

    const bought = await as(request(server()).get(`/api/v1/assets?vendorId=${id}`)).expect(200);
    expect(bought.body.data).toHaveLength(1);
  });
});

describe('maintenance', () => {
  it('moves the asset into maintenance and back to its holder, on the timeline', async () => {
    const assetId = await asset();
    const ada = await person();
    await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: ada })).expect(201);

    const created = await as(
      request(server()).post('/api/v1/maintenance').send({ assetId, type: 'repair', title: 'Replace keyboard', startNow: true, moveAsset: true }),
    ).expect(201);
    expect(created.body.data).toMatchObject({ status: 'in_progress', assetName: 'Latitude 7440', assetMovedToMaintenance: true });
    expect((await as(request(server()).get(`/api/v1/assets/${assetId}`))).body.data.lifecycleState).toBe('maintenance');

    const done = await as(
      request(server())
        .post(`/api/v1/maintenance/${created.body.data.id}/complete`)
        .send({ outcome: 'Keyboard replaced', cost: { amountMinor: 8900, currency: 'GBP' } }),
    ).expect(200);
    expect(done.body.data.assetWarning).toBeNull();

    // Still assigned, so back to Deployed — not onto the shelf.
    expect((await as(request(server()).get(`/api/v1/assets/${assetId}`))).body.data.lifecycleState).toBe('deployed');

    const timeline = await as(request(server()).get(`/api/v1/assets/${assetId}/timeline`));
    const summaries = timeline.body.data.map((e: { summary: string }) => e.summary);
    expect(summaries).toContain('Repair started: Replace keyboard');
    expect(summaries).toContain('Repair completed: Replace keyboard');

    const costs = await as(request(server()).get(`/api/v1/maintenance/costs?assetId=${assetId}`)).expect(200);
    expect(costs.body.data).toEqual([{ currency: 'GBP', amountMinor: 8900, records: 1 }]);
  });

  it('refuses a move the workflow does not allow, and writes nothing', async () => {
    const assetId = await asset();
    await as(request(server()).post(`/api/v1/assets/${assetId}/transition`).send({ to: 'retired', comment: 'Old' })).expect(200);

    const res = await as(
      request(server()).post('/api/v1/maintenance').send({ assetId, type: 'repair', title: 'Try anyway', startNow: true, moveAsset: true }),
    );
    expect(res.status).toBe(422);
    expect((await as(request(server()).get(`/api/v1/maintenance?assetId=${assetId}`))).body.data).toEqual([]);
  });

  it('schedules the next service when a recurring one is done', async () => {
    const assetId = await asset();
    const scheduled = await as(
      request(server())
        .post('/api/v1/maintenance')
        .send({ assetId, type: 'service', title: 'Annual PAT test', scheduledFor: '2026-01-10', recurrenceMonths: 12 }),
    ).expect(201);

    const done = await as(request(server()).post(`/api/v1/maintenance/${scheduled.body.data.id}/complete`).send({ completedAt: '2026-01-12' })).expect(200);

    expect(done.body.data.next).toMatchObject({ status: 'scheduled', title: 'Annual PAT test', recurrenceMonths: 12 });
    expect(done.body.data.next.scheduledFor.slice(0, 10)).toBe('2027-01-12');
  });

  it('shows up in the attention inbox once its date has passed', async () => {
    const assetId = await asset();
    await as(request(server()).post('/api/v1/maintenance').send({ assetId, type: 'inspection', title: 'Fire check', scheduledFor: '2020-01-01' })).expect(201);

    const res = await as(request(server()).get('/api/v1/dashboard/attention/maintenance')).expect(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ title: 'Fire check', assetId })]);
  });
});

describe('licences', () => {
  it('never hand out more seats than were bought, even when asked at once', async () => {
    const licence = await as(request(server()).post('/api/v1/licences').send({ name: 'Figma Pro', type: 'subscription', seats: 2 })).expect(201);
    const id = licence.body.data.id;
    const people = await Promise.all(['Ada', 'Grace', 'Linus', 'Barbara', 'Ken'].map((n) => person(n)));

    const results = await Promise.all(
      people.map((assigneeId) => as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId }))),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await as(request(server()).get(`/api/v1/licences/${id}`))).body.data.seatsUsed).toBe(2);
  });

  it('refuses a second seat for the same person, and frees a seat for someone else', async () => {
    const id = (await as(request(server()).post('/api/v1/licences').send({ name: 'Adobe CC', type: 'subscription', seats: 1 })).expect(201)).body.data.id;
    const ada = await person('Ada');
    const grace = await person('Grace');

    const seat = await as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId: ada })).expect(201);
    expect(seat.body.data.assigneeName).toBe('Ada Okafor');
    const again = await as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId: ada }));
    expect(again.status).toBe(409);

    await as(request(server()).delete(`/api/v1/licences/${id}/seats/${seat.body.data.id}`)).expect(204);
    await as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId: grace })).expect(201);
  });

  it('will not shrink below the seats in use', async () => {
    const id = (await as(request(server()).post('/api/v1/licences').send({ name: 'Slack', type: 'subscription', seats: 5 })).expect(201)).body.data.id;
    for (const n of ['Ada', 'Grace', 'Linus']) {
      await as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId: await person(n) })).expect(201);
    }
    const res = await as(request(server()).patch(`/api/v1/licences/${id}`).send({ seats: 2 }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('3 seats are in use');
  });

  it('store the key encrypted, show only its last characters, and audit every reveal', async () => {
    const created = await as(
      request(server()).post('/api/v1/licences').send({ name: 'Windows Server', type: 'perpetual', key: 'ABCDE-FGHIJ-KLMNO-PQRST-3F7Q' }),
    ).expect(201);

    expect(JSON.stringify(created.body)).not.toContain('ABCDE');
    expect(created.body.data).toMatchObject({ hasKey: true, keyHint: '••••••••3F7Q' });

    const stored = await runAsSystem({ requestId: 't', tenantId: t.tenantId }, () =>
      LicenceModel.findById(created.body.data.id).select('+keyEncrypted').lean(),
    );
    expect(stored!.keyEncrypted).toMatch(/^v1\./);
    expect(stored!.keyEncrypted).not.toContain('ABCDE');

    const revealed = await as(request(server()).post(`/api/v1/licences/${created.body.data.id}/key`)).expect(200);
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(revealed.body.data.key).toBe('ABCDE-FGHIJ-KLMNO-PQRST-3F7Q');

    const audit = await runAsSystem({ requestId: 't', tenantId: t.tenantId }, () =>
      AuditLogModel.countDocuments({ action: 'licence.key_revealed', entityId: created.body.data.id }),
    );
    expect(audit).toBe(1);
  });

  it('free a leaver’s seats when their offboarding completes', async () => {
    const id = (await as(request(server()).post('/api/v1/licences').send({ name: 'Jira', type: 'subscription', seats: 10 })).expect(201)).body.data.id;
    const ada = await person('Ada');
    await as(request(server()).post(`/api/v1/licences/${id}/seats`).send({ assigneeId: ada })).expect(201);

    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`).send({})).expect(200);
    const checklist = await as(request(server()).get(`/api/v1/people/${ada}/offboarding`)).expect(200);
    expect(checklist.body.data.licenceSeats).toEqual([expect.objectContaining({ licenceName: 'Jira' })]);

    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/complete`).send({})).expect(200);

    expect((await as(request(server()).get(`/api/v1/licences/${id}`))).body.data.seatsUsed).toBe(0);
    expect((await as(request(server()).get(`/api/v1/people/${ada}/licences`))).body.data).toEqual([]);
  });
});
