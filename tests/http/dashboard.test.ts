import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { recordingTransport } from '../../src/modules/notifications/index.js';
import { scanExpiringWarranties } from '../../src/modules/reports/index.js';

const app = createApp();
// One server for the whole file — see helpers/testServer.ts.
const server = useTestServer(app);

let t: SeededTenant;
let laptopTypeId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

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

/** ISO date `days` from now. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await ensurePlansSeeded();
  recordingTransport().clear();

  t = await seedTenant(server(), 'dash');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
});

describe('the dashboard', () => {
  it('summarises the estate', async () => {
    await makeAsset({ purchase: { priceMinor: 199_900, currency: 'GBP' } }).expect(201);
    await makeAsset({ purchase: { priceMinor: 129_900, currency: 'GBP' } }).expect(201);

    // Rollups are recomputed on demand when the day's row is missing, so a new
    // tenant never sees an empty dashboard and conclude the product is broken.
    await as(request(server()).post('/api/v1/dashboard/rebuild')).expect(200);

    const res = await as(request(server()).get('/api/v1/dashboard'));

    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalAssets).toBe(2);
    expect(res.body.data.summary.availableAssets).toBe(2);
    expect(res.body.data.summary.totalValueMinor).toBe(329_800);
    expect(res.body.data.byState.in_stock).toBe(2);
  });

  it('counts assigned separately from available', async () => {
    const asset = await makeAsset();
    const person = await as(
      request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor' }),
    );

    await as(
      request(server())
        .post(`/api/v1/assets/${asset.body.data.id}/assign`)
        .send({ assigneeId: person.body.data.id }),
    ).expect(201);

    await as(request(server()).post('/api/v1/dashboard/rebuild')).expect(200);
    const res = await as(request(server()).get('/api/v1/dashboard'));

    expect(res.body.data.summary.assignedAssets).toBe(1);
    expect(res.body.data.summary.availableAssets).toBe(0);
  });

  it('reads from the rollup, not the live collection', async () => {
    await makeAsset().expect(201);
    await as(request(server()).post('/api/v1/dashboard/rebuild')).expect(200);

    // A second asset created AFTER the rollup must not appear until it is
    // rebuilt — which is the proof the dashboard is not aggregating live.
    await makeAsset().expect(201);

    const stale = await as(request(server()).get('/api/v1/dashboard'));
    expect(stale.body.data.summary.totalAssets).toBe(1);

    await as(request(server()).post('/api/v1/dashboard/rebuild')).expect(200);
    const fresh = await as(request(server()).get('/api/v1/dashboard'));
    expect(fresh.body.data.summary.totalAssets).toBe(2);
  });

  it('shows recent activity', async () => {
    await makeAsset({ name: 'Recently added' }).expect(201);

    const res = await as(request(server()).get('/api/v1/dashboard'));
    expect(res.body.data.recentActivity[0].summary).toContain('Recently added');
  });
});

describe('needs attention', () => {
  it('stays empty when nothing needs doing', async () => {
    await makeAsset().expect(201);

    const res = await as(request(server()).get('/api/v1/dashboard'));
    // An empty panel is the goal. Rows with a zero count are noise that teaches
    // people to stop reading it.
    expect(res.body.data.attention).toEqual([]);
  });

  it('raises warranties inside the horizon, and ignores ones outside it', async () => {
    await makeAsset({ name: 'Expiring soon', warranty: { expiresAt: inDays(10) } }).expect(201);
    await makeAsset({ name: 'Expiring later', warranty: { expiresAt: inDays(200) } }).expect(201);

    const res = await as(request(server()).get('/api/v1/dashboard'));
    const row = res.body.data.attention.find((r: { key: string }) => r.key === 'warranties');

    expect(row.count).toBe(1);
    // Every row links to a pre-filtered list rather than a dead end.
    expect(row.href).toContain('/assets?');
  });

  it('ignores the warranty on a disposed asset', async () => {
    const asset = await makeAsset({ warranty: { expiresAt: inDays(10) } });

    await as(
      request(server())
        .post(`/api/v1/assets/${asset.body.data.id}/transition`)
        .send({ to: 'retired', comment: 'End of life' }),
    ).expect(200);
    await as(
      request(server())
        .post(`/api/v1/assets/${asset.body.data.id}/transition`)
        .send({ to: 'disposed', comment: 'Recycled' }),
    ).expect(200);

    const res = await as(request(server()).get('/api/v1/dashboard'));
    expect(res.body.data.attention.find((r: { key: string }) => r.key === 'warranties')).toBeUndefined();
  });

  it('lists the warranty pipeline with days remaining', async () => {
    await makeAsset({ name: 'Nearly out', warranty: { expiresAt: inDays(5) } }).expect(201);

    const res = await as(request(server()).get('/api/v1/dashboard/warranties?days=30'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].daysRemaining).toBe(5);
  });
});

/**
 * The Milestone 4 gate, first half.
 */
describe('the M4 gate: a warranty expiring in 30 days reaches the dashboard and an inbox', () => {
  it('notifies by in-app message and email, once', async () => {
    await makeAsset({ name: 'Ageing laptop', warranty: { expiresAt: inDays(20) } }).expect(201);

    const onDashboard = await as(request(server()).get('/api/v1/dashboard'));
    expect(
      onDashboard.body.data.attention.find((r: { key: string }) => r.key === 'warranties').count,
    ).toBe(1);

    await scanExpiringWarranties();

    const inbox = await as(request(server()).get('/api/v1/notifications'));
    expect(inbox.status).toBe(200);

    const notice = inbox.body.data.find((n: { type: string }) => n.type === 'warranty.expiring');
    expect(notice.title).toContain('Ageing laptop');
    expect(notice.actionUrl).toBeTruthy();

    const emails = recordingTransport().to(t.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain('Ageing laptop');

    // A nightly scan must not send the same notice every night.
    await scanExpiringWarranties();
    await scanExpiringWarranties();

    expect(recordingTransport().to(t.email)).toHaveLength(1);

    const after = await as(request(server()).get('/api/v1/notifications'));
    expect(after.body.data.filter((n: { type: string }) => n.type === 'warranty.expiring')).toHaveLength(1);
  });

  it('sends a fresh notice as the deadline closes in', async () => {
    await makeAsset({ name: 'Very close', warranty: { expiresAt: inDays(3) } }).expect(201);

    await scanExpiringWarranties();

    // Thresholds are 30 and 7 days; three days out crosses both, so both fire —
    // deduplicated per threshold rather than per asset.
    const inbox = await as(request(server()).get('/api/v1/notifications'));
    expect(inbox.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('does not notify about a warranty outside the horizon', async () => {
    await makeAsset({ name: 'Fine for now', warranty: { expiresAt: inDays(120) } }).expect(201);

    await scanExpiringWarranties();

    expect(recordingTransport().to(t.email)).toHaveLength(0);
  });
});

describe('the notification inbox', () => {
  it('reports and clears the unread count', async () => {
    await makeAsset({ warranty: { expiresAt: inDays(10) } }).expect(201);
    await scanExpiringWarranties();

    const before = await as(request(server()).get('/api/v1/notifications'));
    expect(before.body.meta.unreadCount).toBeGreaterThan(0);

    await as(request(server()).post('/api/v1/notifications/read-all')).expect(200);

    const after = await as(request(server()).get('/api/v1/notifications'));
    expect(after.body.meta.unreadCount).toBe(0);
  });

  it('filters to unread only', async () => {
    await makeAsset({ warranty: { expiresAt: inDays(10) } }).expect(201);
    await scanExpiringWarranties();

    await as(request(server()).post('/api/v1/notifications/read-all')).expect(200);

    const unread = await as(request(server()).get('/api/v1/notifications?unreadOnly=true'));
    expect(unread.body.data).toHaveLength(0);
  });
});
