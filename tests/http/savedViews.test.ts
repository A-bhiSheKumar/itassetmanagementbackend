import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

/**
 * Saved views are a person's own bookmarks. The properties that matter are the
 * ones that would leak or lose them: another member must not see or delete them,
 * and saving under an existing name must replace rather than duplicate.
 */

const server = useTestServer(createApp());

let owner: SeededTenant;
let other: SeededTenant;

const as = (t: SeededTenant, req: request.Test) => req.set('Authorization', `Bearer ${t.accessToken}`);

beforeEach(async () => {
  await ensurePlansSeeded();
  owner = await seedTenant(server(), 'views-a');
  other = await seedTenant(server(), 'views-b');
});

describe('saved views', () => {
  it('saves a filter set and lists it for that screen', async () => {
    const saved = await as(owner, request(server()).post('/api/v1/saved-views'))
      .send({ module: 'assets', name: 'Deployed laptops', query: '?state=deployed&type=abc' })
      .expect(201);

    // The leading `?` is normalised away, so the stored query round-trips cleanly.
    expect(saved.body.data.query).toBe('state=deployed&type=abc');

    const list = await as(owner, request(server()).get('/api/v1/saved-views?module=assets')).expect(200);
    expect(list.body.data.map((v: { name: string }) => v.name)).toEqual(['Deployed laptops']);

    // Scoped per screen: the assets view does not appear on assignments.
    const elsewhere = await as(owner, request(server()).get('/api/v1/saved-views?module=assignments'));
    expect(elsewhere.body.data).toEqual([]);
  });

  it('replaces a view saved again under the same name', async () => {
    for (const query of ['state=deployed', 'state=in_stock']) {
      await as(owner, request(server()).post('/api/v1/saved-views'))
        .send({ module: 'assets', name: 'Mine', query })
        .expect(201);
    }

    const list = await as(owner, request(server()).get('/api/v1/saved-views?module=assets'));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].query).toBe('state=in_stock');
  });

  it("never shows or deletes another organisation's view", async () => {
    const saved = await as(owner, request(server()).post('/api/v1/saved-views'))
      .send({ module: 'assets', name: 'Private', query: 'state=lost' })
      .expect(201);

    const seen = await as(other, request(server()).get('/api/v1/saved-views?module=assets'));
    expect(seen.body.data).toEqual([]);

    await as(other, request(server()).delete(`/api/v1/saved-views/${saved.body.data.id}`)).expect(404);

    // Still there for its owner.
    const list = await as(owner, request(server()).get('/api/v1/saved-views?module=assets'));
    expect(list.body.data).toHaveLength(1);
  });

  it('refuses a screen that does not support views', async () => {
    await as(owner, request(server()).post('/api/v1/saved-views'))
      .send({ module: 'nonsense', name: 'x', query: '' })
      .expect(422);
  });
});
