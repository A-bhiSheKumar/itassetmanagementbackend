import { describe, it, expect, beforeAll } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { makeTenantPair, asTenant, withoutTenant } from '../helpers/tenantFixtures.js';
import { expectModelIsolation } from '../helpers/isolationHarness.js';
import { withoutTenantScope } from '../../src/core/context/index.js';
import { MissingTenantScopeError, CrossTenantWriteError } from '../../src/core/errors/index.js';
import { markSchemaGlobal } from '../../src/core/db/index.js';

/**
 * The most important test file in the project (docs/08-roadmap.md).
 *
 * If these pass, one query written without a tenant filter fails loudly instead
 * of quietly returning every customer's data.
 */

interface Widget {
  tenantId: string;
  name: string;
  quantity: number;
}

let Widget: mongoose.Model<Widget>;
let GlobalThing: mongoose.Model<{ name: string }>;

beforeAll(() => {
  const widgetSchema = new Schema<Widget>(
    { name: { type: String, required: true }, quantity: { type: Number, default: 0 } },
    { timestamps: true },
  );
  Widget = mongoose.model<Widget>('TestWidget', widgetSchema);

  // A global model — Plan, Tenant, User. Opting out is explicit and rare.
  const globalSchema = markSchemaGlobal(new Schema<{ name: string }>({ name: String }));
  GlobalThing = mongoose.model<{ name: string }>('TestGlobalThing', globalSchema);
});

describe('tenant scoping', () => {
  it('isolates every operation between two tenants', async () => {
    const tenants = makeTenantPair();
    await expectModelIsolation(Widget, tenants, (label) => ({ name: `widget-${label}` }));
  });

  it('stamps tenantId from context on insert', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Widget.create({ name: 'stamped' }));
    expect(doc.tenantId).toBe(a.tenantId);
  });

  it('overrides a client-supplied tenantId on read rather than trusting it', async () => {
    const { a, b } = makeTenantPair();
    await asTenant(b, () => Widget.create({ name: 'b-secret' }));

    // The shape of a real attack: a tenantId smuggled into a query filter.
    const found = await asTenant(a, () => Widget.find({ tenantId: b.tenantId }).lean());
    expect(found).toHaveLength(0);
  });

  it('refuses a cross-tenant write instead of silently re-stamping it', async () => {
    const { a, b } = makeTenantPair();
    await expect(
      asTenant(a, () => Widget.create({ name: 'smuggled', tenantId: b.tenantId })),
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it('scopes insertMany', async () => {
    const { a, b } = makeTenantPair();
    await asTenant(a, () => Widget.insertMany([{ name: 'one' }, { name: 'two' }]));

    expect(await asTenant(a, () => Widget.countDocuments({}))).toBe(2);
    expect(await asTenant(b, () => Widget.countDocuments({}))).toBe(0);
  });

  it('rejects a cross-tenant document inside insertMany', async () => {
    const { a, b } = makeTenantPair();
    await expect(
      asTenant(a, () => Widget.insertMany([{ name: 'ok' }, { name: 'bad', tenantId: b.tenantId }])),
    ).rejects.toThrow(CrossTenantWriteError);
  });
});

describe('missing tenant context', () => {
  /**
   * The behaviour this whole architecture exists for.
   *
   * The dangerous alternative is not "returns nothing" — it is "returns
   * everything, looks like it worked, ships to production".
   */
  it('THROWS on find rather than returning every tenant', async () => {
    const { a } = makeTenantPair();
    await asTenant(a, () => Widget.create({ name: 'private' }));

    await expect(withoutTenant(() => Widget.find({}).exec())).rejects.toThrow(
      MissingTenantScopeError,
    );
  });

  it('throws on save', async () => {
    await expect(withoutTenant(() => Widget.create({ name: 'orphan' }))).rejects.toThrow(
      MissingTenantScopeError,
    );
  });

  it('throws on countDocuments', async () => {
    await expect(withoutTenant(() => Widget.countDocuments({}).exec())).rejects.toThrow(
      MissingTenantScopeError,
    );
  });

  it('throws on aggregate', async () => {
    await expect(withoutTenant(() => Widget.aggregate([{ $count: 'n' }]))).rejects.toThrow(
      MissingTenantScopeError,
    );
  });

  it('throws on updateMany', async () => {
    await expect(
      withoutTenant(() => Widget.updateMany({}, { $set: { name: 'x' } }).exec()),
    ).rejects.toThrow(MissingTenantScopeError);
  });

  it('throws when there is no context at all', async () => {
    await expect(Widget.find({}).exec()).rejects.toThrow(MissingTenantScopeError);
  });
});

describe('withoutTenantScope escape hatch', () => {
  it('reads across tenants when explicitly bypassed', async () => {
    const { a, b } = makeTenantPair();
    await asTenant(a, () => Widget.create({ name: 'a' }));
    await asTenant(b, () => Widget.create({ name: 'b' }));

    const all = await asTenant(a, () =>
      withoutTenantScope('platform metrics rollup', () => Widget.find({}).lean()),
    );
    expect(all).toHaveLength(2);
  });

  it('does not leak the bypass outside its callback', async () => {
    const { a, b } = makeTenantPair();
    await asTenant(a, () => Widget.create({ name: 'a' }));
    await asTenant(b, () => Widget.create({ name: 'b' }));

    const scoped = await asTenant(a, async () => {
      await withoutTenantScope('one-off', () => Widget.find({}).lean());
      return Widget.find({}).lean();
    });

    expect(scoped).toHaveLength(1);
  });
});

describe('global models', () => {
  it('are not tenant-scoped and work without a tenant', async () => {
    await withoutTenant(() => GlobalThing.create({ name: 'starter-plan' }));
    const found = await withoutTenant(() => GlobalThing.find({}).lean());
    expect(found).toHaveLength(1);
  });

  it('do not gain a tenantId field', async () => {
    const doc = await withoutTenant(() => GlobalThing.create({ name: 'pro-plan' }));
    expect((doc as unknown as { tenantId?: string }).tenantId).toBeUndefined();
  });
});
