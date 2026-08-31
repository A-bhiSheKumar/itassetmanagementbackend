import { describe, it, expect, beforeAll } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { makeTenantPair, asTenant } from '../helpers/tenantFixtures.js';

interface Gadget {
  tenantId: string;
  name: string;
  serial?: string;
  deletedAt: Date | null;
  softDelete(): Promise<unknown>;
  restore(): Promise<unknown>;
}

let Gadget: mongoose.Model<Gadget>;

beforeAll(async () => {
  const schema = new Schema<Gadget>(
    { name: { type: String, required: true }, serial: String },
    { timestamps: true },
  );

  /**
   * The partial unique index pattern used throughout the schema layer
   * (docs/03-data-model.md §2).
   *
   * Unique only when the serial is present AND the row is not soft-deleted. A
   * plain unique index would allow exactly one null-serial record per tenant —
   * which breaks every asset that legitimately has no serial (cables, adapters,
   * furniture) — and would keep a deleted asset's serial locked forever.
   */
  schema.index(
    { tenantId: 1, serial: 1 },
    {
      unique: true,
      partialFilterExpression: { serial: { $type: 'string' }, deletedAt: null },
    },
  );

  Gadget = mongoose.model<Gadget>('TestGadget', schema);
  await Gadget.syncIndexes();
});

describe('soft delete', () => {
  it('hides deleted documents from normal reads', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Gadget.create({ name: 'laptop' }));

    await asTenant(a, () => doc.softDelete());

    expect(await asTenant(a, () => Gadget.find({}).lean())).toHaveLength(0);
    expect(await asTenant(a, () => Gadget.countDocuments({}))).toBe(0);
  });

  it('records who deleted it', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Gadget.create({ name: 'monitor' }));
    await asTenant(a, () => doc.softDelete());

    const raw = await asTenant(a, () =>
      Gadget.findById(doc._id).setOptions({ withDeleted: true }).lean<{ deletedAt: Date; deletedBy: string }>(),
    );
    expect(raw?.deletedAt).toBeInstanceOf(Date);
    expect(raw?.deletedBy).toBe(a.userId);
  });

  it('returns deleted documents for a trash view', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Gadget.create({ name: 'dock' }));
    await asTenant(a, () => doc.softDelete());

    const trash = await asTenant(a, () => Gadget.find({}).setOptions({ withDeleted: true }).lean());
    expect(trash).toHaveLength(1);
  });

  it('restores', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Gadget.create({ name: 'keyboard' }));
    await asTenant(a, () => doc.softDelete());
    await asTenant(a, () => doc.restore());

    expect(await asTenant(a, () => Gadget.find({}).lean())).toHaveLength(1);
  });

  it('still enforces tenant isolation on deleted rows', async () => {
    const { a, b } = makeTenantPair();
    const docB = await asTenant(b, () => Gadget.create({ name: 'b-item' }));
    await asTenant(b, () => docB.softDelete());

    const leaked = await asTenant(a, () =>
      Gadget.find({}).setOptions({ withDeleted: true }).lean(),
    );
    expect(leaked).toHaveLength(0);
  });
});

describe('partial unique indexes', () => {
  it('rejects a duplicate serial within one tenant', async () => {
    const { a } = makeTenantPair();
    await asTenant(a, () => Gadget.create({ name: 'one', serial: 'SN-100' }));

    await expect(
      asTenant(a, () => Gadget.create({ name: 'two', serial: 'SN-100' })),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('allows the same serial in a different tenant', async () => {
    const { a, b } = makeTenantPair();
    await asTenant(a, () => Gadget.create({ name: 'a', serial: 'SN-200' }));

    // Would fail if the unique index were not prefixed with tenantId — one
    // customer's serial number would collide with another's.
    await expect(
      asTenant(b, () => Gadget.create({ name: 'b', serial: 'SN-200' })),
    ).resolves.toBeDefined();
  });

  it('allows many records with no serial at all', async () => {
    const { a } = makeTenantPair();
    await asTenant(a, () => Gadget.create({ name: 'cable-1' }));
    await asTenant(a, () => Gadget.create({ name: 'cable-2' }));
    await asTenant(a, () => Gadget.create({ name: 'cable-3' }));

    expect(await asTenant(a, () => Gadget.countDocuments({}))).toBe(3);
  });

  it('frees a serial once the record is soft-deleted', async () => {
    const { a } = makeTenantPair();
    const doc = await asTenant(a, () => Gadget.create({ name: 'old', serial: 'SN-300' }));
    await asTenant(a, () => doc.softDelete());

    await expect(
      asTenant(a, () => Gadget.create({ name: 'replacement', serial: 'SN-300' })),
    ).resolves.toBeDefined();
  });
});
