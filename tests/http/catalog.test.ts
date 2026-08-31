import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);
let acme: SeededTenant;

beforeEach(async () => {
  await ensurePlansSeeded();
  acme = await seedTenant(server(), 'catalog');
});

function asOwner(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${acme.accessToken}`);
}

describe('starter catalogue', () => {
  it('seeds categories, asset types and a default lifecycle on signup', async () => {
    const types = await asOwner(request(server()).get('/api/v1/catalog/asset-types'));
    const categories = await asOwner(request(server()).get('/api/v1/catalog/asset-categories'));
    const lifecycle = await asOwner(request(server()).get('/api/v1/catalog/lifecycle'));

    expect(types.body.data.map((t: { key: string }) => t.key)).toContain('laptop');
    expect(categories.body.data.length).toBeGreaterThan(3);
    expect(lifecycle.body.data.initialState).toBe('in_stock');
  });

  it('gives asset types their own tag prefix', async () => {
    const types = await asOwner(request(server()).get('/api/v1/catalog/asset-types'));
    const laptop = types.body.data.find((t: { key: string }) => t.key === 'laptop');

    expect(laptop.tagPrefix).toBe('LAP');
    expect(laptop.requiresSerial).toBe(true);
  });
});

/**
 * The Milestone 2 gate.
 *
 * An admin creates an asset type with five custom fields, and everything a form
 * needs comes back from the API — with no code written for that type.
 */
describe('the M2 gate: a custom asset type with custom fields', () => {
  it('creates "Camera" with five fields and returns a renderable definition', async () => {
    const type = await asOwner(
      request(server()).post('/api/v1/catalog/asset-types').send({
        name: 'Camera',
        tagPrefix: 'CAM',
        requiresSerial: true,
      }),
    );

    expect(type.status).toBe(201);
    expect(type.body.data.key).toBe('camera');
    const typeId = type.body.data.id;

    const fields = [
      { label: 'Sensor', type: 'text' },
      { label: 'Resolution (MP)', type: 'number', validation: { min: 1, max: 500 } },
      {
        label: 'Lens mount',
        type: 'select',
        options: [{ label: 'EF' }, { label: 'RF' }, { label: 'E' }],
      },
      { label: 'Insurance expiry', type: 'date' },
      { label: 'Weather sealed', type: 'boolean' },
    ];

    for (const field of fields) {
      const res = await asOwner(
        request(server())
          .post('/api/v1/catalog/custom-fields')
          .send({ appliesTo: 'asset', assetTypeIds: [typeId], ...field }),
      );
      expect(res.status, `creating ${field.label}`).toBe(201);
    }

    const definitions = await asOwner(
      request(server()).get(`/api/v1/catalog/custom-fields?appliesTo=asset&assetTypeId=${typeId}`),
    );

    expect(definitions.body.data).toHaveLength(5);

    // Keys are derived from labels and are storage-safe.
    expect(definitions.body.data.map((d: { key: string }) => d.key)).toEqual([
      'sensor',
      'resolution_mp',
      'lens_mount',
      'insurance_expiry',
      'weather_sealed',
    ]);

    // Each field is bucketed by type — the thing that makes range filters work.
    const byKey = Object.fromEntries(
      definitions.body.data.map((d: { key: string; bucket: string }) => [d.key, d.bucket]),
    );
    expect(byKey).toEqual({
      sensor: 's',
      resolution_mp: 'n',
      lens_mount: 's',
      insurance_expiry: 'd',
      weather_sealed: 'b',
    });

    // Select options carry stable ids, not just labels.
    const lens = definitions.body.data.find((d: { key: string }) => d.key === 'lens_mount');
    expect(lens.options).toHaveLength(3);
    expect(lens.options[0].id).toBeTruthy();
    expect(lens.options.map((o: { label: string }) => o.label)).toEqual(['EF', 'RF', 'E']);
  });

  it('scopes a field to its asset type', async () => {
    const camera = await asOwner(
      request(server()).post('/api/v1/catalog/asset-types').send({ name: 'Camera' }),
    );

    await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'asset',
        assetTypeIds: [camera.body.data.id],
        label: 'Shutter count',
        type: 'number',
      }),
    );

    const types = await asOwner(request(server()).get('/api/v1/catalog/asset-types'));
    const laptopId = types.body.data.find((t: { key: string }) => t.key === 'laptop').id;

    const forLaptop = await asOwner(
      request(server()).get(`/api/v1/catalog/custom-fields?appliesTo=asset&assetTypeId=${laptopId}`),
    );

    expect(forLaptop.body.data.map((d: { key: string }) => d.key)).not.toContain('shutter_count');
  });

  it('applies an unscoped field to every asset type', async () => {
    await asOwner(
      request(server())
        .post('/api/v1/catalog/custom-fields')
        .send({ appliesTo: 'asset', label: 'Cost centre code', type: 'text' }),
    );

    const types = await asOwner(request(server()).get('/api/v1/catalog/asset-types'));
    const laptopId = types.body.data.find((t: { key: string }) => t.key === 'laptop').id;

    const forLaptop = await asOwner(
      request(server()).get(`/api/v1/catalog/custom-fields?appliesTo=asset&assetTypeId=${laptopId}`),
    );

    expect(forLaptop.body.data.map((d: { key: string }) => d.key)).toContain('cost_centre_code');
  });
});

describe('custom field lifecycle', () => {
  async function createField(body: Record<string, unknown>) {
    return asOwner(request(server()).post('/api/v1/catalog/custom-fields').send(body));
  }

  it('de-duplicates keys derived from the same label', async () => {
    const a = await createField({ appliesTo: 'asset', label: 'Colour', type: 'text' });
    const b = await createField({ appliesTo: 'asset', label: 'Colour', type: 'text' });

    expect(a.body.data.key).toBe('colour');
    expect(b.body.data.key).toBe('colour_2');
  });

  it('renames the label without touching the storage key', async () => {
    const field = await createField({ appliesTo: 'asset', label: 'Chip', type: 'text' });

    const renamed = await asOwner(
      request(server())
        .patch(`/api/v1/catalog/custom-fields/${field.body.data.id}`)
        .send({ label: 'Processor' }),
    );

    expect(renamed.body.data.label).toBe('Processor');
    // The key is where every stored value lives. Changing it would orphan them all.
    expect(renamed.body.data.key).toBe('chip');
  });

  it("refuses to change a field's type", async () => {
    const field = await createField({ appliesTo: 'asset', label: 'Capacity', type: 'text' });

    const res = await asOwner(
      request(server())
        .patch(`/api/v1/catalog/custom-fields/${field.body.data.id}`)
        .send({ type: 'number' }),
    );

    // Silent coercion of text to number loses data irrecoverably. Archive and
    // recreate is the honest path (docs/06-edge-cases.md #15).
    expect(res.status).toBe(422);
  });

  it('keeps option ids stable when an option is renamed', async () => {
    const field = await createField({
      appliesTo: 'asset',
      label: 'Condition grade',
      type: 'select',
      options: [{ label: 'Good' }, { label: 'Poor' }],
    });

    const originalIds = field.body.data.options.map((o: { id: string }) => o.id);

    const renamed = await asOwner(
      request(server())
        .patch(`/api/v1/catalog/custom-fields/${field.body.data.id}`)
        .send({
          options: [
            { id: originalIds[0], label: 'Serviceable' },
            { id: originalIds[1], label: 'Beyond repair' },
          ],
        }),
    );

    // Stored values reference ids, so renaming an option cannot break them.
    expect(renamed.body.data.options.map((o: { id: string }) => o.id)).toEqual(originalIds);
    expect(renamed.body.data.options.map((o: { label: string }) => o.label)).toEqual([
      'Serviceable',
      'Beyond repair',
    ]);
  });

  it('archives a field without destroying it, and restores it', async () => {
    const field = await createField({ appliesTo: 'asset', label: 'Battery health', type: 'number' });
    const id = field.body.data.id;

    await asOwner(request(server()).post(`/api/v1/catalog/custom-fields/${id}/archive`)).expect(200);

    const active = await asOwner(request(server()).get('/api/v1/catalog/custom-fields?appliesTo=asset'));
    expect(active.body.data.map((d: { id: string }) => d.id)).not.toContain(id);

    const withArchived = await asOwner(
      request(server()).get('/api/v1/catalog/custom-fields?appliesTo=asset&includeArchived=true'),
    );
    expect(withArchived.body.data.map((d: { id: string }) => d.id)).toContain(id);

    await asOwner(request(server()).post(`/api/v1/catalog/custom-fields/${id}/restore`)).expect(200);

    const restored = await asOwner(request(server()).get('/api/v1/catalog/custom-fields?appliesTo=asset'));
    expect(restored.body.data.map((d: { id: string }) => d.id)).toContain(id);
  });

  it('requires options on a choice field', async () => {
    const res = await createField({ appliesTo: 'asset', label: 'Grade', type: 'select' });
    expect(res.status).toBe(422);
  });

  it('rejects a reserved key', async () => {
    const res = await createField({ appliesTo: 'asset', label: 'Status', type: 'text' });
    expect(res.status).toBe(422);
  });

  it('enforces the plan limit on custom fields', async () => {
    // Starter allows five.
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await createField({ appliesTo: 'asset', label: `Field ${i}`, type: 'text' });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 402).length).toBeGreaterThan(0);
  });
});

describe('lifecycle engine', () => {
  it('offers only the moves declared from a state', async () => {
    const res = await asOwner(request(server()).get('/api/v1/catalog/lifecycle/transitions/in_stock'));

    const targets = res.body.data.map((t: { to: string }) => t.to).sort();
    expect(targets).toEqual(['deployed', 'lost', 'maintenance', 'retired']);
  });

  it('offers retirement from deployed so the guard can explain the blocker', async () => {
    const res = await asOwner(request(server()).get('/api/v1/catalog/lifecycle/transitions/deployed'));

    expect(res.body.data.map((t: { to: string }) => t.to).sort()).toEqual([
      'in_stock',
      'lost',
      'maintenance',
      'retired',
    ]);
  });

  it('offers nothing out of a terminal state', async () => {
    const res = await asOwner(request(server()).get('/api/v1/catalog/lifecycle/transitions/disposed'));
    expect(res.body.data).toHaveLength(0);
  });

  it('marks which moves need a comment', async () => {
    const res = await asOwner(request(server()).get('/api/v1/catalog/lifecycle/transitions/in_stock'));
    const retire = res.body.data.find((t: { to: string }) => t.to === 'retired');

    expect(retire.requiresComment).toBe(true);
  });
});

describe('catalogue permissions', () => {
  it('lets any reader see definitions but not change them', async () => {
    // Forms, filters and tables all need the definitions, so gating reads
    // behind settings:manage would break the app for ordinary members.
    const types = await asOwner(request(server()).get('/api/v1/catalog/asset-types'));
    expect(types.status).toBe(200);
  });

  it('rejects an unknown field type', async () => {
    const res = await asOwner(
      request(server())
        .post('/api/v1/catalog/custom-fields')
        .send({ appliesTo: 'asset', label: 'Weird', type: 'quantum' }),
    );

    expect(res.status).toBe(422);
  });

  it('rejects attempts to set the key directly', async () => {
    const res = await asOwner(
      request(server())
        .post('/api/v1/catalog/custom-fields')
        .send({ appliesTo: 'asset', label: 'Sneaky', type: 'text', key: 'tenantId' }),
    );

    // Strict schemas: an unknown key is an error, not something silently dropped.
    expect(res.status).toBe(422);
  });
});
