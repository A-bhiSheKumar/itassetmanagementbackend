import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { runAsSystem } from '../../src/core/context/index.js';
import { AssetModel } from '../../src/modules/assets/index.js';
import { AssignmentModel } from '../../src/modules/assignments/index.js';
import { TenantUsageModel } from '../../src/modules/subscriptions/index.js';
import { reconcileTenant } from '../../src/modules/reports/index.js';

/**
 * Drift is forced here with raw collection writes, deliberately.
 *
 * The application cannot produce these states — the cached pointer is written
 * only inside the assignment transaction. But a migration, a partial restore or
 * a future bug can, and the job exists for exactly that. Writing round the
 * service is the only way to test that it would be caught.
 */

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;
let laptopTypeId: string;
let adaId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

function makeAsset(): request.Test {
  return as(
    request(server())
      .post('/api/v1/assets')
      .send({
        name: 'MacBook Pro',
        assetTypeId: laptopTypeId,
        serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}`,
      }),
  );
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem({ requestId: 'reconcile-test', tenantId: t.tenantId }, fn);
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'reconcile');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;

  const ada = await as(
    request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor' }),
  );
  adaId = ada.body.data.id;
});

describe('a healthy tenant', () => {
  it('reports no drift', async () => {
    const asset = await makeAsset();
    await as(
      request(server()).post(`/api/v1/assets/${asset.body.data.id}/assign`).send({ assigneeId: adaId }),
    ).expect(201);

    const report = await inTenant(() => reconcileTenant(t.tenantId));

    expect(report.discrepancies).toEqual([]);
    expect(report.checked.assets).toBe(1);
    expect(report.checked.assignments).toBe(1);
  });
});

describe('an asset that looks free but is not', () => {
  it('is detected, because it would be double-assigned', async () => {
    const asset = await makeAsset();
    const assetId = asset.body.data.id;

    await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: adaId }));

    // Force the cache to disagree with the assignment collection.
    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        { $set: { currentAssignment: null } },
      );
    });

    const report = await inTenant(() => reconcileTenant(t.tenantId));

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]!.kind).toBe('assignment_missing_from_asset');
    expect(report.discrepancies[0]!.detail).toContain('shows as unassigned');
  });

  it('is repaired when asked, and the asset is held again', async () => {
    const asset = await makeAsset();
    const assetId = asset.body.data.id;

    await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: adaId }));

    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        { $set: { currentAssignment: null } },
      );
    });

    const report = await inTenant(() => reconcileTenant(t.tenantId, { repair: true }));
    expect(report.repaired).toBe(1);

    const after = await as(request(server()).get(`/api/v1/assets/${assetId}`));
    expect(after.body.data.currentAssignment.assigneeId).toBe(adaId);

    // And it stays fixed.
    const second = await inTenant(() => reconcileTenant(t.tenantId));
    expect(second.discrepancies).toEqual([]);
  });
});

describe('an asset that looks held but is not', () => {
  it('is detected, because nobody can assign it', async () => {
    const asset = await makeAsset();

    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        {
          $set: {
            currentAssignment: {
              assignmentId: '000000000000000000000000',
              assigneeType: 'person',
              assigneeId: adaId,
              assignedAt: new Date(),
            },
          },
        },
      );
    });

    const report = await inTenant(() => reconcileTenant(t.tenantId));

    expect(report.discrepancies[0]!.kind).toBe('asset_points_at_nothing');
    expect(report.discrepancies[0]!.detail).toContain('shows as assigned');
  });

  it('is repaired, and the asset becomes assignable again', async () => {
    const asset = await makeAsset();
    const assetId = asset.body.data.id;

    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        {
          $set: {
            currentAssignment: {
              assignmentId: '000000000000000000000000',
              assigneeType: 'person',
              assigneeId: adaId,
              assignedAt: new Date(),
            },
          },
        },
      );
    });

    await inTenant(() => reconcileTenant(t.tenantId, { repair: true }));

    // The point of the repair: the asset was unusable and now is not.
    await as(
      request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: adaId }),
    ).expect(201);
  });
});

describe('an asset pointing at the wrong assignment', () => {
  it('is detected and corrected to the active one', async () => {
    const asset = await makeAsset();
    const assetId = asset.body.data.id;

    await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: adaId }));
    await as(request(server()).post(`/api/v1/assets/${assetId}/return`).send({}));
    await as(request(server()).post(`/api/v1/assets/${assetId}/assign`).send({ assigneeId: adaId }));

    const [stale] = await inTenant(() =>
      AssignmentModel.find({ status: 'returned' }).select('_id').lean(),
    );

    // Point the asset at the OLD, returned assignment.
    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        { $set: { 'currentAssignment.assignmentId': String(stale!._id) } },
      );
    });

    const report = await inTenant(() => reconcileTenant(t.tenantId));
    expect(report.discrepancies[0]!.kind).toBe('asset_points_at_wrong_assignment');

    await inTenant(() => reconcileTenant(t.tenantId, { repair: true }));

    const clean = await inTenant(() => reconcileTenant(t.tenantId));
    expect(clean.discrepancies).toEqual([]);
  });
});

describe('usage counters', () => {
  it('detects a count that has drifted from reality', async () => {
    await makeAsset();
    await makeAsset();

    await inTenant(async () => {
      await TenantUsageModel.collection.updateOne(
        { tenantId: t.tenantId },
        { $set: { assetCount: 99 } },
      );
    });

    const report = await inTenant(() => reconcileTenant(t.tenantId));

    // Usage drives plan enforcement, so drift either blocks a customer who is
    // within their limit or lets one past it.
    const usageDrift = report.discrepancies.find((d) => d.kind === 'usage_count_wrong');
    expect(usageDrift!.detail).toContain('99');
    expect(usageDrift!.detail).toContain('actual is 2');
  });

  it('corrects it, so plan limits are enforced against the truth', async () => {
    await makeAsset();

    await inTenant(async () => {
      await TenantUsageModel.collection.updateOne(
        { tenantId: t.tenantId },
        { $set: { assetCount: 9_999 } },
      );
    });

    await inTenant(() => reconcileTenant(t.tenantId, { repair: true }));

    const usage = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(usage.body.data.usage.assets).toBe(1);
  });
});

describe('reporting versus repairing', () => {
  it('changes nothing unless repair is asked for', async () => {
    const asset = await makeAsset();

    await inTenant(async () => {
      await AssetModel.collection.updateOne(
        { tenantId: t.tenantId, assetTag: asset.body.data.assetTag },
        { $set: { currentAssignment: { assignmentId: 'x', assigneeType: 'person', assigneeId: adaId, assignedAt: new Date() } } },
      );
    });

    const dryRun = await inTenant(() => reconcileTenant(t.tenantId));

    expect(dryRun.discrepancies).toHaveLength(1);
    expect(dryRun.repaired).toBe(0);
    expect(dryRun.discrepancies[0]!.repaired).toBe(false);

    // Still broken — a report is a report.
    const stillBroken = await inTenant(() => reconcileTenant(t.tenantId));
    expect(stillBroken.discrepancies).toHaveLength(1);
  });
});
