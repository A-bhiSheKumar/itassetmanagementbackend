import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded } from '../helpers/factories.js';
import { INDUSTRY_PRESETS } from '../../src/modules/catalog/index.js';

const app = createApp();
const server = useTestServer(app);

async function registerWith(industry: string | undefined) {
  const res = await request(server())
    .post('/api/v1/auth/register')
    .send({
      email: `${industry ?? 'default'}-${ulid().toLowerCase()}@example.test`,
      password: 'correct-horse-battery-staple',
      name: 'Owner',
      organisationName: `${industry ?? 'default'} Ltd`,
      ...(industry ? { industry } : {}),
    })
    .expect(201);

  const userToken = res.body.data.accessToken as string;
  const tenantId = res.body.data.tenant.id as string;
  const selected = await request(server())
    .post('/api/v1/auth/select-tenant')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ tenantId })
    .expect(200);

  return { token: selected.body.data.accessToken as string, tenantId };
}

const as = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  await ensurePlansSeeded();
});

describe('starter setups', () => {
  it('are listed without an account, because signup asks before there is one', async () => {
    const res = await request(server()).get('/api/v1/tenant/industries').expect(200);
    expect(res.body.data.map((p: { key: string }) => p.key)).toEqual(INDUSTRY_PRESETS.map((p) => p.key));
    expect(res.body.data.find((p: { key: string }) => p.key === 'fleet')).toMatchObject({
      vocabulary: { asset: 'vehicle', assets: 'vehicles' },
      modules: { licences: false },
    });
  });

  it('seed a fleet organisation with vehicles, its own wording, and no software section', async () => {
    const { token } = await registerWith('fleet');
    const auth = as(token);

    const types = await auth(request(server()).get('/api/v1/catalog/asset-types')).expect(200);
    expect(types.body.data.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['Car', 'Van', 'Trailer']));
    expect(types.body.data.map((t: { name: string }) => t.name)).not.toContain('Laptop');

    const fields = await auth(request(server()).get('/api/v1/catalog/custom-fields?appliesTo=asset')).expect(200);
    const registration = fields.body.data.find((f: { label: string }) => f.label === 'Registration');
    expect(registration).toMatchObject({ type: 'text', display: expect.objectContaining({ showInTable: true }) });

    // Driver fields too — a preset can extend people, not only things.
    const personFields = await auth(request(server()).get('/api/v1/catalog/custom-fields?appliesTo=person')).expect(200);
    expect(personFields.body.data.map((f: { label: string }) => f.label)).toContain('Licence number');

    const me = await auth(request(server()).get('/api/v1/me')).expect(200);
    expect(me.body.data.tenant).toMatchObject({
      industry: 'fleet',
      vocabulary: { asset: 'vehicle', assets: 'vehicles', person: 'driver', people: 'drivers' },
      modules: { licences: false, maintenance: true, vendors: true },
    });
  });

  it('leave a blank organisation with no taxonomy, but still able to create', async () => {
    const { token } = await registerWith('blank');
    const auth = as(token);

    const types = await auth(request(server()).get('/api/v1/catalog/asset-types')).expect(200);
    expect(types.body.data).toEqual([]);

    // The lifecycle still exists, so the first type they add works immediately.
    const created = await auth(request(server()).post('/api/v1/catalog/asset-types').send({ name: 'Excavator', tagPrefix: 'EXC' })).expect(201);
    const asset = await auth(
      request(server()).post('/api/v1/assets').send({ name: '5-tonne digger', assetTypeId: created.body.data.id }),
    );
    expect(asset.status).toBe(201);
    expect(asset.body.data.lifecycleState).toBe('in_stock');
  });

  it('default to IT when signup says nothing', async () => {
    const { token } = await registerWith(undefined);
    const me = await as(token)(request(server()).get('/api/v1/me'));
    expect(me.body.data.tenant.industry).toBe('it');
  });

  it('can be adopted later, adding what is missing without duplicating what is there', async () => {
    const { token } = await registerWith('it');
    const auth = as(token);

    const first = await auth(request(server()).post('/api/v1/tenant/industry-preset').send({ industry: 'tools', adoptWording: true })).expect(200);
    expect(first.body.data.added).toMatchObject({ preset: 'tools' });
    expect(first.body.data.added.types).toBeGreaterThan(0);
    expect(first.body.data.tenant.settings.vocabulary).toMatchObject({ asset: 'item', person: 'operator' });

    // Twice is a no-op: the same names are already there.
    const again = await auth(request(server()).post('/api/v1/tenant/industry-preset').send({ industry: 'tools' })).expect(200);
    expect(again.body.data.added).toMatchObject({ categories: 0, types: 0, fields: 0 });

    // And the IT types it started with are untouched.
    const types = await auth(request(server()).get('/api/v1/catalog/asset-types'));
    expect(types.body.data.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['Laptop', 'Generator']));
  });

  it('refuse wording that would blank out a label', async () => {
    const { token } = await registerWith('it');
    const res = await as(token)(
      request(server()).patch('/api/v1/tenant').send({ settings: { vocabulary: { asset: '', assets: 'x', person: 'y', people: 'z' } } }),
    );
    expect(res.status).toBe(422);
  });
});
