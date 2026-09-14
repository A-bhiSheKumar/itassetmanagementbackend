import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
const server = useTestServer(app);
let t: SeededTenant;
let laptopTypeId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

async function location(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await as(request(server()).post('/api/v1/locations').send({ name, ...body })).expect(201);
  return res.body.data.id as string;
}

async function asset(locationId: string, name = 'MacBook Pro'): Promise<string> {
  const res = await as(
    request(server())
      .post('/api/v1/assets')
      .send({
        name,
        assetTypeId: laptopTypeId,
        serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}`,
        placement: { locationId },
      }),
  ).expect(201);
  return res.body.data.id as string;
}

async function person(locationId: string): Promise<string> {
  const res = await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor', locationId })).expect(201);
  return res.body.data.id as string;
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'structure');
  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
});

describe('the location list', () => {
  it('says how many people and assets sit in each location', async () => {
    const leeds = await location('Leeds');
    const empty = await location('Empty');
    await asset(leeds);
    await asset(leeds);
    await person(leeds);

    const res = await as(request(server()).get('/api/v1/locations')).expect(200);
    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));

    expect(byId.get(leeds)).toMatchObject({ name: 'Leeds', peopleCount: 1, assetCount: 2 });
    expect(byId.get(empty)).toMatchObject({ peopleCount: 0, assetCount: 0 });
  });

  it('does not count deleted assets', async () => {
    const leeds = await location('Leeds');
    const id = await asset(leeds);
    await as(request(server()).delete(`/api/v1/assets/${id}`)).expect(204);

    const res = await as(request(server()).get('/api/v1/locations'));
    expect(res.body.data[0].assetCount).toBe(0);
  });
});

describe('deleting a location', () => {
  it('is refused while assets are placed there, with the count', async () => {
    const leeds = await location('Leeds');
    await asset(leeds);

    const res = await as(request(server()).delete(`/api/v1/locations/${leeds}`));

    // Deleting it would leave the laptop placed nowhere, with no record of where it was.
    expect(res.status).toBe(409);
    expect(res.body.error.details.references).toContainEqual({ type: 'asset', count: 1 });
  });

  it('goes through once it is empty', async () => {
    const leeds = await location('Leeds');
    await as(request(server()).delete(`/api/v1/locations/${leeds}`)).expect(204);
  });
});

describe('moving everything out of a location', () => {
  it('moves the people and assets, and each asset records the move on its timeline', async () => {
    const leeds = await location('Leeds');
    const manchester = await location('Manchester');
    const laptop = await asset(leeds);
    await asset(leeds, 'ThinkPad');
    const ada = await person(leeds);

    const res = await as(
      request(server()).post(`/api/v1/locations/${leeds}/move-contents`).send({ toId: manchester }),
    ).expect(200);
    expect(res.body.data).toEqual({ people: 1, assets: 2 });

    const moved = await as(request(server()).get(`/api/v1/assets/${laptop}`));
    expect(moved.body.data.placement.locationId).toBe(manchester);

    const holder = await as(request(server()).get(`/api/v1/people/${ada}`));
    expect(holder.body.data.locationId).toBe(manchester);

    const timeline = await as(request(server()).get(`/api/v1/assets/${laptop}/timeline`));
    expect(timeline.body.data.map((e: { summary: string }) => e.summary)).toContain('MacBook Pro moved from Leeds to Manchester');

    // And now the delete that was refused goes through.
    await as(request(server()).delete(`/api/v1/locations/${leeds}`)).expect(204);
  });

  it('keeps an edit made after the move from being silently overwritten by a stale form', async () => {
    const leeds = await location('Leeds');
    const manchester = await location('Manchester');
    const laptop = await asset(leeds);
    const before = await as(request(server()).get(`/api/v1/assets/${laptop}`));

    await as(request(server()).post(`/api/v1/locations/${leeds}/move-contents`).send({ toId: manchester })).expect(200);

    // A form opened before the move still carries the old version.
    const stale = await as(
      request(server()).patch(`/api/v1/assets/${laptop}`).send({ name: 'Renamed', version: before.body.data.version }),
    );
    expect(stale.status).toBe(409);
  });

  it('refuses to move into the same place, or into an archived one', async () => {
    const leeds = await location('Leeds');
    const closed = await location('Closed');
    await as(request(server()).patch(`/api/v1/locations/${closed}`).send({ status: 'archived' })).expect(200);

    const same = await as(request(server()).post(`/api/v1/locations/${leeds}/move-contents`).send({ toId: leeds }));
    expect(same.status).toBe(422);

    const archived = await as(request(server()).post(`/api/v1/locations/${leeds}/move-contents`).send({ toId: closed }));
    expect(archived.status).toBe(422);
    expect(archived.body.error.message).toContain('archived');
  });

  it('is 404 for a destination in another organisation', async () => {
    const leeds = await location('Leeds');
    const other = await seedTenant(server(), 'structure-other');
    const theirs = await request(server())
      .post('/api/v1/locations')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ name: 'Theirs' })
      .expect(201);

    const res = await as(
      request(server()).post(`/api/v1/locations/${leeds}/move-contents`).send({ toId: theirs.body.data.id }),
    );
    expect(res.status).toBe(404);
  });
});

describe('departments', () => {
  it('move people and assets the same way', async () => {
    const make = async (name: string) =>
      (await as(request(server()).post('/api/v1/departments').send({ name })).expect(201)).body.data.id as string;
    const sales = await make('Sales');
    const ops = await make('Operations');

    const res = await as(request(server()).post('/api/v1/assets').send({
      name: 'iPad',
      assetTypeId: laptopTypeId,
      serialNumber: 'SN-DEPT-1',
      placement: { departmentId: sales },
    })).expect(201);

    await as(request(server()).post(`/api/v1/departments/${sales}/move-contents`).send({ toId: ops })).expect(200);

    const moved = await as(request(server()).get(`/api/v1/assets/${res.body.data.id}`));
    expect(moved.body.data.placement.departmentId).toBe(ops);
  });
});
