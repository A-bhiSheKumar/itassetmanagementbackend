import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);
let t: SeededTenant;
let laptopTypeId: string;
let adaId: string;
let bilalId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

// Returns the supertest Test, not a promise wrapping it, so `.expect()` chains.
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
  t = await seedTenant(server(), 'assets');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;

  const ada = await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor' }));
  const bilal = await as(request(server()).post('/api/v1/people').send({ firstName: 'Bilal', lastName: 'Rahman' }));
  adaId = ada.body.data.id;
  bilalId = bilal.body.data.id;
});

describe('asset creation', () => {
  it('generates a sequential tag from the type prefix', async () => {
    const a = await makeAsset();
    const b = await makeAsset();

    expect(a.status).toBe(201);
    expect(a.body.data.assetTag).toBe('LAP-0001');
    expect(b.body.data.assetTag).toBe('LAP-0002');
  });

  it('generates unique tags under concurrent creation', async () => {
    // The reason counter.model.ts exists. count()+1 or max+1 would hand the
    // same number to several of these and the unique index would reject them.
    const results = await Promise.all(Array.from({ length: 10 }, () => makeAsset()));

    const failures = results.filter((r) => r.status !== 201).map((r) => JSON.stringify(r.body));
    expect(failures, failures.join('\n')).toHaveLength(0);

    const tags = results.map((r) => r.body.data.assetTag);
    expect(new Set(tags).size).toBe(10);
  });

  it('requires a serial number when the type demands one', async () => {
    const res = await as(
      request(server()).post('/api/v1/assets').send({ name: 'No serial', assetTypeId: laptopTypeId }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.fields.serialNumber).toBeDefined();
  });

  it('allows many assets with no serial when the type permits it', async () => {
    const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
    const accessoryId = types.body.data.find((x: { key: string }) => x.key === 'accessory').id;

    for (const name of ['USB-C cable', 'HDMI cable', 'Dock']) {
      const res = await as(request(server()).post('/api/v1/assets').send({ name, assetTypeId: accessoryId }));
      expect(res.status, name).toBe(201);
    }
  });

  it('rejects a duplicate serial within the tenant', async () => {
    await makeAsset({ serialNumber: 'C02XY1234' }).expect(201);
    const dup = await makeAsset({ serialNumber: 'C02XY1234' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('starts in stock, unassigned, with the three axes separate', async () => {
    const res = await makeAsset({ condition: 'new' });

    expect(res.body.data.lifecycleState).toBe('in_stock');
    expect(res.body.data.condition).toBe('new');
    expect(res.body.data.currentAssignment).toBeNull();
  });
});

/**
 * The Milestone 3 gate.
 */
describe('the M3 gate: concurrent assignment', () => {
  it('lets exactly one of two simultaneous assigns win', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    const [first, second] = await Promise.all([
      as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId })),
      as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: bilalId })),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe('ASSET_ALREADY_ASSIGNED');
    // The conflict names the current holder, so the UI can offer "transfer
    // instead?" rather than a dead end.
    expect(loser.body.error.details.assigneeId).toBeTruthy();

    // And exactly one active assignment exists.
    const history = await as(request(server()).get(`/api/v1/assets/${id}/assignments`));
    expect(history.body.data.filter((a: { status: string }) => a.status === 'active')).toHaveLength(1);
  });

  it('holds under heavier contention', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId })),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });
});

describe('assign, return, transfer', () => {
  async function assigned() {
    const asset = await makeAsset();
    const id = asset.body.data.id;
    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId })).expect(201);
    return id;
  }

  it('caches the holder on the asset and deploys it', async () => {
    const id = await assigned();
    const asset = await as(request(server()).get(`/api/v1/assets/${id}`));

    expect(asset.body.data.currentAssignment.assigneeId).toBe(adaId);
    // Assigning deploys. Left as a separate step, estates drift into
    // "assigned but still in stock".
    expect(asset.body.data.lifecycleState).toBe('deployed');
  });

  it('returns, clears the holder and records the condition', async () => {
    const id = await assigned();

    const res = await as(
      request(server()).post(`/api/v1/assets/${id}/return`).send({ condition: 'poor', notes: 'Cracked lid' }),
    );
    expect(res.status).toBe(200);

    const asset = await as(request(server()).get(`/api/v1/assets/${id}`));
    expect(asset.body.data.currentAssignment).toBeNull();
    expect(asset.body.data.lifecycleState).toBe('in_stock');
    expect(asset.body.data.condition).toBe('poor');
  });

  it('can be reassigned after a return', async () => {
    const id = await assigned();
    await as(request(server()).post(`/api/v1/assets/${id}/return`).send({})).expect(200);

    // The partial unique index only constrains ACTIVE rows, which is what
    // allows a full history and a fresh assignment.
    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: bilalId })).expect(201);

    const history = await as(request(server()).get(`/api/v1/assets/${id}/assignments`));
    expect(history.body.data).toHaveLength(2);
    expect(history.body.data.filter((a: { status: string }) => a.status === 'active')).toHaveLength(1);
  });

  it('transfers atomically, linking the two assignments', async () => {
    const id = await assigned();

    const res = await as(
      request(server()).post(`/api/v1/assets/${id}/transfer`).send({ toAssigneeId: bilalId }),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.previousAssignmentId).toBeTruthy();

    const asset = await as(request(server()).get(`/api/v1/assets/${id}`));
    expect(asset.body.data.currentAssignment.assigneeId).toBe(bilalId);
    // Never unassigned in between — a transfer is one operation, not two.
    expect(asset.body.data.lifecycleState).toBe('deployed');
  });

  it('refuses to transfer to the current holder', async () => {
    const id = await assigned();
    const res = await as(request(server()).post(`/api/v1/assets/${id}/transfer`).send({ toAssigneeId: adaId }));

    expect(res.status).toBe(422);
  });

  it('refuses to return an asset nobody holds', async () => {
    const asset = await makeAsset();
    const res = await as(request(server()).post(`/api/v1/assets/${asset.body.data.id}/return`).send({}));

    expect(res.status).toBe(422);
  });

  it('refuses to assign to someone who is leaving', async () => {
    await as(request(server()).post(`/api/v1/people/${bilalId}/deactivate`)).expect(200);

    const asset = await makeAsset();
    const res = await as(
      request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: bilalId }),
    );

    expect(res.status).toBe(422);
  });

  it('lists everything a person holds', async () => {
    const a = await makeAsset();
    const b = await makeAsset();

    for (const asset of [a, b]) {
      await as(request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: adaId }));
    }

    const held = await as(request(server()).get(`/api/v1/assignments?assigneeId=${adaId}&status=active`));
    expect(held.body.data).toHaveLength(2);
  });
});

/**
 * The second half of the gate: the timeline shows every change with actor,
 * before and after.
 */
describe('the timeline', () => {
  it('records the whole story of an asset', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    await as(request(server()).patch(`/api/v1/assets/${id}`).send({ model: 'M3 Pro' })).expect(200);
    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId })).expect(201);
    await as(request(server()).post(`/api/v1/assets/${id}/transfer`).send({ toAssigneeId: bilalId })).expect(200);
    await as(request(server()).post(`/api/v1/assets/${id}/return`).send({ condition: 'fair' })).expect(200);

    const timeline = await as(request(server()).get(`/api/v1/assets/${id}/timeline`));

    expect(timeline.status).toBe(200);
    const types = timeline.body.data.map((e: { type: string }) => e.type);

    expect(types).toContain('asset.created');
    expect(types).toContain('asset.updated');
    expect(types).toContain('asset.assigned');
    expect(types).toContain('asset.transferred');
    expect(types).toContain('asset.returned');

    // Newest first.
    expect(types[0]).toBe('asset.returned');
  });

  it('records before and after for a field change', async () => {
    const asset = await makeAsset({ model: 'Old model' });
    const id = asset.body.data.id;

    await as(request(server()).patch(`/api/v1/assets/${id}`).send({ model: 'New model' })).expect(200);

    const timeline = await as(request(server()).get(`/api/v1/assets/${id}/timeline`));
    const update = timeline.body.data.find((e: { type: string }) => e.type === 'asset.updated');

    const change = update.changes.find((c: { field: string }) => c.field === 'model');
    expect(change).toMatchObject({ label: 'Model', from: 'Old model', to: 'New model' });
  });

  it('names the actor by reference, never by a copied name', async () => {
    const asset = await makeAsset();
    const timeline = await as(request(server()).get(`/api/v1/assets/${asset.body.data.id}/timeline`));

    // ADR-013: a copied name would make GDPR erasure destroy history.
    expect(timeline.body.data[0].actorId).toBe(t.userId);
    expect(JSON.stringify(timeline.body.data)).not.toContain(t.email);
  });

  it('writes a readable summary for a transfer', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId }));
    await as(request(server()).post(`/api/v1/assets/${id}/transfer`).send({ toAssigneeId: bilalId }));

    const timeline = await as(request(server()).get(`/api/v1/assets/${id}/timeline`));
    const transfer = timeline.body.data.find((e: { type: string }) => e.type === 'asset.transferred');

    expect(transfer.summary).toContain('Ada Okafor');
    expect(transfer.summary).toContain('Bilal Rahman');
  });

  it('does not duplicate entries when an event is redelivered', async () => {
    const asset = await makeAsset();
    const { dispatchPending } = await import('../../src/core/events/index.js');

    // Force a second dispatch pass. sourceEventId carries a unique index, so
    // the projector is idempotent and this must be a no-op.
    await dispatchPending(100);
    await dispatchPending(100);

    const timeline = await as(request(server()).get(`/api/v1/assets/${asset.body.data.id}/timeline`));
    expect(timeline.body.data.filter((e: { type: string }) => e.type === 'asset.created')).toHaveLength(1);
  });
});

describe('the audit log', () => {
  it('records every asset action', async () => {
    const asset = await makeAsset();
    await as(request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: adaId }));

    const audit = await as(request(server()).get('/api/v1/audit-logs?entityType=asset'));

    expect(audit.status).toBe(200);
    const actions = audit.body.data.map((a: { action: string }) => a.action);
    expect(actions).toContain('asset.created');
    expect(actions).toContain('asset.assigned');
  });

  it('exposes no way to modify or delete a record', async () => {
    // Append-only is enforced by the absence of a route, which is a stronger
    // guarantee than a permission check someone can misconfigure.
    await request(server())
      .post('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${t.accessToken}`)
      .send({ action: 'forged' })
      .expect(404);

    await request(server())
      .delete('/api/v1/audit-logs/anything')
      .set('Authorization', `Bearer ${t.accessToken}`)
      .expect(404);
  });
});

describe('lifecycle transitions', () => {
  it('refuses a move the workflow does not declare', async () => {
    const asset = await makeAsset();

    const res = await as(
      request(server()).post(`/api/v1/assets/${asset.body.data.id}/transition`).send({ to: 'disposed' }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    // The message lists the legal moves rather than leaving a dead end.
    expect(res.body.error.message).toContain('you can:');
  });

  it('enforces a guard that depends on assignment state', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;
    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId }));

    const res = await as(
      request(server()).post(`/api/v1/assets/${id}/transition`).send({ to: 'retired', comment: 'End of life' }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('still assigned');
  });

  it('requires a comment where the workflow demands one', async () => {
    const asset = await makeAsset();

    const res = await as(
      request(server()).post(`/api/v1/assets/${asset.body.data.id}/transition`).send({ to: 'retired' }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.fields.comment).toBeDefined();
  });

  it('records the transition on the timeline', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    await as(
      request(server()).post(`/api/v1/assets/${id}/transition`).send({ to: 'retired', comment: 'Beyond economic repair' }),
    ).expect(200);

    const timeline = await as(request(server()).get(`/api/v1/assets/${id}/timeline`));
    const entry = timeline.body.data.find((e: { type: string }) => e.type === 'asset.transitioned');

    expect(entry.comment).toBe('Beyond economic repair');
    expect(entry.changes[0]).toMatchObject({ field: 'lifecycleState', from: 'in_stock', to: 'retired' });
  });
});

describe('deletion', () => {
  it('refuses to delete an assigned asset', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;
    await as(request(server()).post(`/api/v1/assets/${id}/assign`).send({ assigneeId: adaId }));

    const res = await as(request(server()).delete(`/api/v1/assets/${id}`));
    expect(res.status).toBe(422);
  });

  it('frees the tag and serial on delete, and restores', async () => {
    const asset = await makeAsset({ serialNumber: 'REUSE-1' });
    const id = asset.body.data.id;

    await as(request(server()).delete(`/api/v1/assets/${id}`)).expect(204);

    // The partial unique indexes exclude deleted rows, so the serial is free.
    const reused = await makeAsset({ serialNumber: 'REUSE-1' });
    expect(reused.status).toBe(201);

    // …which means restoring the original would now clash. Say so plainly.
    const restore = await as(request(server()).post(`/api/v1/assets/${id}/restore`));
    expect(restore.status).toBe(422);
  });

  it('restores cleanly when nothing has claimed the tag', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;

    await as(request(server()).delete(`/api/v1/assets/${id}`)).expect(204);
    await as(request(server()).get(`/api/v1/assets/${id}`)).expect(404);

    const restored = await as(request(server()).post(`/api/v1/assets/${id}/restore`));
    expect(restored.status).toBe(200);
    await as(request(server()).get(`/api/v1/assets/${id}`)).expect(200);
  });
});

describe('filtering and custom fields', () => {
  it('filters on a custom field with a typed comparison', async () => {
    await as(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'asset',
        assetTypeIds: [laptopTypeId],
        label: 'RAM (GB)',
        type: 'number',
      }),
    ).expect(201);

    for (const ram of [8, 16, 36]) {
      const r = await makeAsset({ name: `Laptop ${ram}GB`, customFields: { ram_gb: ram } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }

    // The reason values are stored by type: in an untyped map "16" < "9" and
    // this comparison would be silently wrong.
    const res = await as(request(server()).get('/api/v1/assets?filter[cf.n.ram_gb][gte]=16'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((a: { customFields: { ram_gb: number } }) => a.customFields.ram_gb).sort()).toEqual([16, 36]);
  });

  it('filters by state, and by whether anything is assigned', async () => {
    const a = await makeAsset();
    await makeAsset();
    await as(request(server()).post(`/api/v1/assets/${a.body.data.id}/assign`).send({ assigneeId: adaId }));

    const deployed = await as(request(server()).get('/api/v1/assets?lifecycleState=deployed'));
    expect(deployed.body.data).toHaveLength(1);

    const free = await as(request(server()).get('/api/v1/assets?unassigned=true'));
    expect(free.body.data).toHaveLength(1);
  });

  it('ignores an unknown filter operator rather than passing it to the driver', async () => {
    // Otherwise the query string becomes a way to inject Mongo operators.
    const res = await as(request(server()).get('/api/v1/assets?filter[cf.n.ram_gb][$where]=1'));
    expect(res.status).toBe(200);
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 4; i += 1) await makeAsset({ name: `Asset ${i}` });

    const first = await as(request(server()).get('/api/v1/assets?limit=2'));
    expect(first.body.meta.pagination.hasMore).toBe(true);

    const second = await as(
      request(server()).get(`/api/v1/assets?limit=2&cursor=${first.body.meta.pagination.cursor}`),
    );

    const ids = [...first.body.data, ...second.body.data].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('optimistic locking', () => {
  it('rejects a stale write', async () => {
    const asset = await makeAsset();
    const id = asset.body.data.id;
    const version = asset.body.data.version;

    await as(request(server()).patch(`/api/v1/assets/${id}`).send({ name: 'First edit', version })).expect(200);

    const res = await as(request(server()).patch(`/api/v1/assets/${id}`).send({ name: 'Second edit', version }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_WRITE');
  });
});
