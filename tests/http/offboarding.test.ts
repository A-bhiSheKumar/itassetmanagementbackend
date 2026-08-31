import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;
let laptopTypeId: string;
let ada: string;
let bilal: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

function makeAsset(body: Record<string, unknown> = {}): request.Test {
  return as(
    request(server())
      .post('/api/v1/assets')
      .send({
        name: 'MacBook Pro 14',
        assetTypeId: laptopTypeId,
        serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}`,
        ...body,
      }),
  );
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'offboard');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;

  const a = await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor' }));
  const b = await as(request(server()).post('/api/v1/people').send({ firstName: 'Bilal', lastName: 'Rahman' }));
  ada = a.body.data.id;
  bilal = b.body.data.id;
});

async function giveAda(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const asset = await makeAsset({ name: `Device ${i}` });
    await as(request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: ada }));
    ids.push(asset.body.data.id);
  }
  return ids;
}

/**
 * The Milestone 4 gate, second half.
 */
describe('the M4 gate: offboarding surfaces everything a person holds', () => {
  it('lists every outstanding item with enough detail to collect it', async () => {
    await giveAda(3);

    const res = await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`));

    expect(res.status).toBe(200);
    expect(res.body.data.personName).toBe('Ada Okafor');
    expect(res.body.data.status).toBe('offboarding');
    expect(res.body.data.outstanding).toHaveLength(3);
    expect(res.body.data.clearToDeactivate).toBe(false);

    const item = res.body.data.outstanding[0];
    expect(item.assetTag).toMatch(/^LAP-\d{4}$/);
    expect(item.assetName).toBeTruthy();
    expect(item.condition).toBeTruthy();
  });

  it('is clear to deactivate when they hold nothing', async () => {
    const res = await as(request(server()).post(`/api/v1/people/${bilal}/offboarding/start`));

    expect(res.body.data.outstanding).toHaveLength(0);
    expect(res.body.data.clearToDeactivate).toBe(true);
  });
});

describe('offboarding flow', () => {
  it('marks them as leaving rather than deactivating outright', async () => {
    await giveAda(1);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    const person = await as(request(server()).get(`/api/v1/people/${ada}`));

    // Deliberately NOT inactive: an inactive person cannot be assigned to,
    // which would block the transfers offboarding usually involves.
    expect(person.body.data.status).toBe('offboarding');
  });

  it('refuses to complete while items are outstanding, and says which', async () => {
    await giveAda(2);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    const res = await as(request(server()).post(`/api/v1/people/${ada}/offboarding/complete`).send({}));

    expect(res.status).toBe(422);
    // A refusal that lists what is still out, so the answer is actionable.
    expect(res.body.error.fields.outstanding).toHaveLength(2);
    expect(res.body.error.message).toContain('still holds 2 items');
  });

  it('completes once everything is returned', async () => {
    const assets = await giveAda(2);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    for (const id of assets) {
      await as(request(server()).post(`/api/v1/assets/${id}/return`).send({ condition: 'good' })).expect(200);
    }

    const checklist = await as(request(server()).get(`/api/v1/people/${ada}/offboarding`));
    expect(checklist.body.data.clearToDeactivate).toBe(true);

    const done = await as(request(server()).post(`/api/v1/people/${ada}/offboarding/complete`).send({}));
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('inactive');
  });

  it('allows a deliberate write-off, and only when forced', async () => {
    await giveAda(1);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/complete`).send({})).expect(422);

    // "We never got the laptop back" is a real outcome, and exactly the fact an
    // audit later asks about — so it has to be possible, and recorded.
    const forced = await as(
      request(server()).post(`/api/v1/people/${ada}/offboarding/complete`).send({ force: true }),
    );

    expect(forced.status).toBe(200);
    expect(forced.body.data.status).toBe('inactive');
  });

  it('lets items be transferred rather than returned', async () => {
    const [assetId] = await giveAda(1);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    // Transferring to a colleague is the common case, and it needs the leaver
    // to still be a valid holder while it happens.
    await as(
      request(server()).post(`/api/v1/assets/${assetId}/transfer`).send({ toAssigneeId: bilal }),
    ).expect(200);

    const checklist = await as(request(server()).get(`/api/v1/people/${ada}/offboarding`));
    expect(checklist.body.data.clearToDeactivate).toBe(true);
  });

  it('shows offboarding people on the dashboard', async () => {
    await giveAda(1);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    const dashboard = await as(request(server()).get('/api/v1/dashboard'));
    const row = dashboard.body.data.attention.find((r: { key: string }) => r.key === 'offboarding');

    expect(row.count).toBe(1);
    expect(row.tone).toBe('danger');
  });

  it('notifies whoever started it about what is outstanding', async () => {
    await giveAda(2);
    await as(request(server()).post(`/api/v1/people/${ada}/offboarding/start`)).expect(200);

    const inbox = await as(request(server()).get('/api/v1/notifications'));
    const notice = inbox.body.data.find((n: { type: string }) => n.type === 'offboarding.outstanding');

    expect(notice.title).toContain('Ada Okafor');
    expect(notice.title).toContain('2 items');
  });

  it('refuses to assign anything new to someone already gone', async () => {
    await as(request(server()).post(`/api/v1/people/${bilal}/offboarding/start`)).expect(200);
    await as(request(server()).post(`/api/v1/people/${bilal}/offboarding/complete`).send({})).expect(200);

    const asset = await makeAsset();
    const res = await as(
      request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: bilal }),
    );

    expect(res.status).toBe(422);
  });
});
