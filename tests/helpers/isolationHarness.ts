/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'vitest';
import type { Model } from 'mongoose';
import { asTenant, type TenantPair } from './tenantFixtures.js';

/**
 * Reusable model-level isolation assertions.
 *
 * Every tenant-scoped model gets run through this. When the HTTP layer lands in
 * M1 it is joined by a route-level harness generated from the route table, so a
 * new endpoint cannot ship without an isolation test (docs/08-roadmap.md).
 *
 * Typed loosely on purpose: this runs against every model in the system, and a
 * generic constraint tight enough to satisfy Mongoose's document types would
 * make the harness unusable for exactly the models it exists to protect.
 */
export async function expectModelIsolation(
  model: Model<any>,
  tenants: TenantPair,
  makeDoc: (label: string) => Record<string, unknown>,
): Promise<void> {
  const docA = await asTenant(tenants.a, () => model.create(makeDoc('a')));
  const docB = await asTenant(tenants.b, () => model.create(makeDoc('b')));

  // ── Read ────────────────────────────────────────────────────────────────
  const aSees: any[] = await asTenant(tenants.a, () => model.find({}).lean());
  expect(aSees).toHaveLength(1);
  expect(String(aSees[0]?._id)).toBe(String(docA._id));

  // ── Read by id ──────────────────────────────────────────────────────────
  // The most common IDOR shape: a real, valid id belonging to another tenant.
  const stolen = await asTenant(tenants.a, () => model.findById(docB._id).lean());
  expect(stolen).toBeNull();

  // ── Update ──────────────────────────────────────────────────────────────
  const updated = await asTenant(tenants.a, () =>
    model.updateOne({ _id: docB._id }, { $set: { name: 'hijacked' } }),
  );
  expect(updated.matchedCount).toBe(0);

  // ── Delete ──────────────────────────────────────────────────────────────
  const deleted = await asTenant(tenants.a, () => model.deleteOne({ _id: docB._id }));
  expect(deleted.deletedCount).toBe(0);

  // ── Count ───────────────────────────────────────────────────────────────
  expect(await asTenant(tenants.a, () => model.countDocuments({}))).toBe(1);

  // ── Aggregate ───────────────────────────────────────────────────────────
  // The subtle one: a $match appended AFTER a $group would filter results that
  // had already been computed across every tenant. The plugin unshifts it.
  const grouped: any[] = await asTenant(tenants.a, () =>
    model.aggregate([{ $group: { _id: '$tenantId', n: { $sum: 1 } } }]),
  );
  expect(grouped).toHaveLength(1);
  expect(grouped[0]?._id).toBe(tenants.a.tenantId);

  // ── B is untouched ──────────────────────────────────────────────────────
  const bStillThere: any = await asTenant(tenants.b, () => model.findById(docB._id).lean());
  expect(bStillThere).not.toBeNull();
  expect(bStillThere.name).not.toBe('hijacked');
}
