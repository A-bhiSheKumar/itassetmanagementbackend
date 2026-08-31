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
  acme = await seedTenant(server(), 'people');
});

function asOwner(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${acme.accessToken}`);
}

// Returns the supertest Test itself, not a promise wrapping it, so `.expect()`
// chaining works.
function createPerson(body: Record<string, unknown>): request.Test {
  return asOwner(request(server()).post('/api/v1/people').send(body));
}

describe('people', () => {
  it('creates someone who can hold an asset without a login', async () => {
    const res = await createPerson({
      firstName: 'Ada',
      lastName: 'Okafor',
      email: 'ada@acme.test',
      jobTitle: 'Field engineer',
      type: 'contractor',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.fullName).toBe('Ada Okafor');
    // A contractor holds equipment but never signs in — and never uses a seat.
    expect(res.body.data.membershipId).toBeNull();
  });

  it('allows many people with no email', async () => {
    // A plain unique index would permit exactly one null-email person per
    // tenant. Warehouse and site staff frequently have none.
    for (const last of ['One', 'Two', 'Three']) {
      const r = await createPerson({ firstName: 'X', lastName: last });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }

    const list = await asOwner(request(server()).get('/api/v1/people'));
    expect(list.body.data).toHaveLength(3);
  });

  it('rejects a duplicate email within the tenant', async () => {
    await createPerson({ firstName: 'A', lastName: 'One', email: 'dup@acme.test' }).expect(201);
    const res = await createPerson({ firstName: 'B', lastName: 'Two', email: 'dup@acme.test' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('clears an email back to null rather than an empty string', async () => {
    const created = await createPerson({ firstName: 'A', lastName: 'One', email: 'a@acme.test' });

    await asOwner(
      request(server()).patch(`/api/v1/people/${created.body.data.id}`).send({ email: null }),
    ).expect(200);

    // An empty string would collide on the partial unique index the moment a
    // second person was also cleared.
    const second = await createPerson({ firstName: 'B', lastName: 'Two', email: null });
    expect(second.status).toBe(201);
  });

  it('rejects a reference to a department that does not exist', async () => {
    const res = await createPerson({
      firstName: 'A',
      lastName: 'One',
      departmentId: '507f1f77bcf86cd799439011',
    });

    expect(res.status).toBe(422);
    expect(res.body.error.fields.departmentId).toBeDefined();
  });

  it('refuses to let someone manage themselves', async () => {
    const person = await createPerson({ firstName: 'A', lastName: 'One' });

    const res = await asOwner(
      request(server())
        .patch(`/api/v1/people/${person.body.data.id}`)
        .send({ managerId: person.body.data.id }),
    );

    expect(res.status).toBe(422);
  });

  it('refuses a reporting loop', async () => {
    const a = await createPerson({ firstName: 'A', lastName: 'One' });
    const b = await createPerson({ firstName: 'B', lastName: 'Two', managerId: a.body.data.id });

    // A reports to B, B reports to A — every org-chart walk would spin.
    const res = await asOwner(
      request(server()).patch(`/api/v1/people/${a.body.data.id}`).send({ managerId: b.body.data.id }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.fields.managerId).toBeDefined();
  });

  it('will not delete someone who still has direct reports', async () => {
    const manager = await createPerson({ firstName: 'M', lastName: 'Boss' });
    await createPerson({ firstName: 'R', lastName: 'Report', managerId: manager.body.data.id });

    const res = await asOwner(request(server()).delete(`/api/v1/people/${manager.body.data.id}`));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_IN_USE');
  });

  it('enforces the plan limit on people', async () => {
    // Starter allows 100 — check the counter moves rather than creating 100.
    const before = await asOwner(request(server()).get('/api/v1/tenant/usage'));
    await createPerson({ firstName: 'A', lastName: 'One' });
    const after = await asOwner(request(server()).get('/api/v1/tenant/usage'));

    expect(after.body.data.usage.people).toBe(before.body.data.usage.people + 1);
  });
});

describe('search and pagination', () => {
  beforeEach(async () => {
    for (const [first, last] of [
      ['Ada', 'Okafor'],
      ['Bilal', 'Rahman'],
      ['Chen', 'Wu'],
      ['Dara', 'Novak'],
    ]) {
      await createPerson({ firstName: first, lastName: last });
    }
  });

  it('finds someone by a prefix of their name', async () => {
    const res = await asOwner(request(server()).get('/api/v1/people?q=oka'));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].lastName).toBe('Okafor');
  });

  it('paginates with a cursor and reports whether more remain', async () => {
    const first = await asOwner(request(server()).get('/api/v1/people?limit=2'));

    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.hasMore).toBe(true);
    expect(first.body.meta.pagination.cursor).toBeTruthy();

    const second = await asOwner(
      request(server()).get(`/api/v1/people?limit=2&cursor=${first.body.meta.pagination.cursor}`),
    );

    expect(second.body.data).toHaveLength(2);
    expect(second.body.meta.pagination.hasMore).toBe(false);

    // No overlap between pages.
    const firstIds = first.body.data.map((p: { id: string }) => p.id);
    const secondIds = second.body.data.map((p: { id: string }) => p.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0);
  });

  it('returns page one for a malformed cursor rather than failing', async () => {
    const res = await asOwner(request(server()).get('/api/v1/people?limit=2&cursor=not-a-cursor'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('caps the page size', async () => {
    const res = await asOwner(request(server()).get('/api/v1/people?limit=5000'));
    expect(res.status).toBe(422);
  });
});

describe('custom fields on a person', () => {
  it('validates values against the tenant definitions and returns them flat', async () => {
    await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'person',
        label: 'Desk number',
        type: 'number',
        validation: { min: 1, max: 999 },
      }),
    ).expect(201);

    const ok = await createPerson({
      firstName: 'Ada',
      lastName: 'Okafor',
      customFields: { desk_number: 42 },
    });

    expect(ok.status).toBe(201);
    // Buckets are storage; the contract is flat.
    expect(ok.body.data.customFields).toEqual({ desk_number: 42 });

    const tooHigh = await createPerson({
      firstName: 'B',
      lastName: 'Two',
      customFields: { desk_number: 5000 },
    });

    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.error.fields['customFields.desk_number']).toBeDefined();
  });

  it('rejects a value for a field that does not exist', async () => {
    // Silently dropping it would leave the user staring at a form that appears
    // to save and never does.
    const res = await createPerson({
      firstName: 'A',
      lastName: 'One',
      customFields: { not_a_field: 'x' },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.fields['customFields.not_a_field']).toBeDefined();
  });

  it('enforces required custom fields', async () => {
    await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'person',
        label: 'Security clearance',
        type: 'select',
        options: [{ label: 'Standard' }, { label: 'Enhanced' }],
        validation: { required: true },
      }),
    ).expect(201);

    const res = await createPerson({ firstName: 'A', lastName: 'One' });
    expect(res.status).toBe(422);
  });

  it('stores a select value as its option id, not its label', async () => {
    const field = await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'person',
        label: 'Shift',
        type: 'select',
        options: [{ label: 'Days' }, { label: 'Nights' }],
      }),
    );

    const optionId = field.body.data.options[0].id;

    const byLabel = await createPerson({
      firstName: 'A',
      lastName: 'One',
      customFields: { shift: 'Days' },
    });
    expect(byLabel.status).toBe(422);

    const byId = await createPerson({
      firstName: 'B',
      lastName: 'Two',
      customFields: { shift: optionId },
    });
    expect(byId.status).toBe(201);
    expect(byId.body.data.customFields.shift).toBe(optionId);
  });
});

describe('departments and locations', () => {
  async function createDepartment(body: Record<string, unknown>) {
    return asOwner(request(server()).post('/api/v1/departments').send(body));
  }

  it('builds a materialised path for a nested department', async () => {
    const eng = await createDepartment({ name: 'Engineering' });
    const platform = await createDepartment({ name: 'Platform', parentId: eng.body.data.id });
    const infra = await createDepartment({ name: 'Infrastructure', parentId: platform.body.data.id });

    expect(eng.body.data.path).toEqual([]);
    expect(platform.body.data.path).toEqual([eng.body.data.id]);
    expect(infra.body.data.path).toEqual([eng.body.data.id, platform.body.data.id]);
  });

  it('rewrites descendant paths when a subtree moves', async () => {
    const a = await createDepartment({ name: 'A' });
    const b = await createDepartment({ name: 'B' });
    const child = await createDepartment({ name: 'Child', parentId: a.body.data.id });
    const grandchild = await createDepartment({ name: 'Grandchild', parentId: child.body.data.id });

    await asOwner(
      request(server()).patch(`/api/v1/departments/${child.body.data.id}`).send({ parentId: b.body.data.id }),
    ).expect(200);

    const all = await asOwner(request(server()).get('/api/v1/departments'));
    const updated = all.body.data.find((d: { id: string }) => d.id === grandchild.body.data.id);

    // The whole subtree has to follow, or "everything under B" misses it.
    expect(updated.path).toEqual([b.body.data.id, child.body.data.id]);
  });

  it('refuses a move that would create a loop', async () => {
    const parent = await createDepartment({ name: 'Parent' });
    const child = await createDepartment({ name: 'Child', parentId: parent.body.data.id });

    const res = await asOwner(
      request(server()).patch(`/api/v1/departments/${parent.body.data.id}`).send({ parentId: child.body.data.id }),
    );

    expect(res.status).toBe(422);
  });

  it('blocks deleting a department that people or children reference', async () => {
    const dept = await createDepartment({ name: 'Support' });
    await createPerson({ firstName: 'A', lastName: 'One', departmentId: dept.body.data.id });

    const res = await asOwner(request(server()).delete(`/api/v1/departments/${dept.body.data.id}`));

    expect(res.status).toBe(409);
    expect(res.body.error.details.references).toContainEqual({ type: 'person', count: 1 });
  });

  it('validates a location time zone', async () => {
    const bad = await asOwner(
      request(server()).post('/api/v1/locations').send({ name: 'Nowhere', timezone: 'Mars/Olympus' }),
    );
    expect(bad.status).toBe(422);

    const good = await asOwner(
      request(server()).post('/api/v1/locations').send({ name: 'Sydney', timezone: 'Australia/Sydney' }),
    );
    expect(good.status).toBe(201);
  });
});

describe('PATCH semantics for custom fields', () => {
  it('merges rather than replacing, so unmentioned fields survive', async () => {
    for (const label of ['Desk number', 'Locker number']) {
      await asOwner(
        request(server())
          .post('/api/v1/catalog/custom-fields')
          .send({ appliesTo: 'person', label, type: 'number' }),
      ).expect(201);
    }

    const person = await createPerson({
      firstName: 'Ada',
      lastName: 'Okafor',
      customFields: { desk_number: 42, locker_number: 7 },
    });

    expect(person.status, JSON.stringify(person.body)).toBe(201);

    const updated = await asOwner(
      request(server())
        .patch(`/api/v1/people/${person.body.data.id}`)
        .send({ customFields: { desk_number: 43 } }),
    );

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    // Parsing only what was sent would have wiped locker_number silently.
    expect(updated.body.data.customFields).toEqual({ desk_number: 43, locker_number: 7 });
  });

  it('cannot be used to bypass a required field on create', async () => {
    await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'person',
        label: 'Badge number',
        type: 'text',
        validation: { required: true },
      }),
    ).expect(201);

    // Omitting the key entirely must not skip validation.
    const omitted = await createPerson({ firstName: 'A', lastName: 'One' });
    expect(omitted.status).toBe(422);

    const empty = await createPerson({ firstName: 'B', lastName: 'Two', customFields: {} });
    expect(empty.status).toBe(422);

    const supplied = await createPerson({
      firstName: 'C',
      lastName: 'Three',
      customFields: { badge_number: 'B-100' },
    });
    expect(supplied.status).toBe(201);
  });

  it('names the choices when a select value is wrong', async () => {
    const field = await asOwner(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'person',
        label: 'Shift pattern',
        type: 'select',
        options: [{ label: 'Days' }, { label: 'Nights' }],
      }),
    );
    expect(field.status).toBe(201);

    const res = await createPerson({
      firstName: 'A',
      lastName: 'One',
      customFields: { shift_pattern: 'Weekends' },
    });

    // Zod's default enum message lists raw ULIDs, which help nobody.
    expect(res.body.error.fields['customFields.shift_pattern'][0]).toContain('Days, Nights');
  });
});
