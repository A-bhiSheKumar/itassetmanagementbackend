import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { runAsSystem } from '../../src/core/context/index.js';
import { AssetModel } from '../../src/modules/assets/index.js';
import { DocumentModel } from '../../src/modules/documents/index.js';
import { AuditLogModel } from '../../src/modules/auditlog/index.js';
import { purgeExpired } from '../../src/modules/recycleBin/index.js';
import { getStorage } from '../../src/core/storage/index.js';

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;
let laptopTypeId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

async function makeAsset(name = 'MacBook Pro'): Promise<string> {
  const res = await as(
    request(server())
      .post('/api/v1/assets')
      .send({ name, assetTypeId: laptopTypeId, serialNumber: `SN-${Math.random().toString(36).slice(2, 10)}` }),
  ).expect(201);
  return res.body.data.id as string;
}

const bin = async () => (await as(request(server()).get('/api/v1/recycle-bin')).expect(200)).body.data as Array<Record<string, unknown>>;

/** Moves a deletion back in time, past the restore window. */
async function age(model: { collection: { updateOne: (...a: never[]) => Promise<unknown> } }, id: string, hours: number) {
  const { Types } = await import('mongoose');
  await model.collection.updateOne(
    { _id: new Types.ObjectId(id) } as never,
    { $set: { deletedAt: new Date(Date.now() - hours * 3_600_000) } } as never,
  );
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'bin');
  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
});

describe('the recycle bin', () => {
  it('holds a deleted asset, says who deleted it, and gives it back', async () => {
    const id = await makeAsset();
    await as(request(server()).delete(`/api/v1/assets/${id}`)).expect(204);

    const [item] = await bin();
    expect(item).toMatchObject({ type: 'asset', id, name: 'MacBook Pro' });
    expect(item!.deletedByName).toBeTruthy();
    expect(new Date(item!.restorableUntil as string).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    await as(request(server()).post(`/api/v1/recycle-bin/assets/${id}/restore`)).expect(200);

    await as(request(server()).get(`/api/v1/assets/${id}`)).expect(200);
    expect(await bin()).toEqual([]);
  });

  it('restores a person, unless someone else has taken their email since', async () => {
    const first = await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Okafor', email: 'ada@bin.test' })).expect(201);
    await as(request(server()).delete(`/api/v1/people/${first.body.data.id}`)).expect(204);

    // Deleting freed the address, and it has been reused.
    await as(request(server()).post('/api/v1/people').send({ firstName: 'Ada', lastName: 'Again', email: 'ada@bin.test' })).expect(201);

    const refused = await as(request(server()).post(`/api/v1/recycle-bin/people/${first.body.data.id}/restore`));
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.email[0]).toContain('ada@bin.test');
  });

  it('brings back a location at the top level when its parent has gone too', async () => {
    const parent = await as(request(server()).post('/api/v1/locations').send({ name: 'Leeds' })).expect(201);
    const child = await as(request(server()).post('/api/v1/locations').send({ name: 'Floor 2', parentId: parent.body.data.id })).expect(201);

    await as(request(server()).delete(`/api/v1/locations/${child.body.data.id}`)).expect(204);
    await as(request(server()).delete(`/api/v1/locations/${parent.body.data.id}`)).expect(204);

    await as(request(server()).post(`/api/v1/recycle-bin/locations/${child.body.data.id}/restore`)).expect(200);

    const list = await as(request(server()).get('/api/v1/locations'));
    expect(list.body.data).toEqual([expect.objectContaining({ name: 'Floor 2', parentId: null, path: [] })]);
  });

  it('refuses to restore something past the window', async () => {
    const id = await makeAsset();
    await as(request(server()).delete(`/api/v1/assets/${id}`)).expect(204);
    await age(AssetModel as never, id, 25);

    expect(await bin()).toEqual([]);
    const res = await as(request(server()).post(`/api/v1/recycle-bin/assets/${id}/restore`));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('more than a day ago');
  });

  it('is 404 for something that was never deleted', async () => {
    const id = await makeAsset();
    await as(request(server()).post(`/api/v1/recycle-bin/assets/${id}/restore`)).expect(404);
  });
});

describe('deleted files', () => {
  const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), Buffer.alloc(64)]);

  async function uploadTo(assetId: string): Promise<string> {
    const presigned = await as(
      request(server()).post('/api/v1/documents/presign').send({ entityType: 'asset', entityId: assetId, fileName: 'invoice.pdf', sizeBytes: PDF.length, category: 'invoice' }),
    ).expect(201);
    await request(server()).put(presigned.body.data.upload.url).set('Content-Type', 'application/octet-stream').send(PDF);
    await as(request(server()).post(`/api/v1/documents/${presigned.body.data.documentId}/confirm`)).expect(200);
    return presigned.body.data.documentId as string;
  }

  it('keep the file until the bin is purged, so a restored file still downloads', async () => {
    const docId = await uploadTo(await makeAsset());
    await as(request(server()).delete(`/api/v1/documents/${docId}`)).expect(204);

    expect((await bin()).map((i) => i.name)).toEqual(['invoice.pdf']);
    await as(request(server()).post(`/api/v1/recycle-bin/documents/${docId}/restore`)).expect(200);

    const link = await as(request(server()).get(`/api/v1/documents/${docId}/download?as=link`)).expect(200);
    await request(server()).get(link.body.data.url).expect(200);
  });

  it('are gone for good once purged — row, file and all — and the purge is audited', async () => {
    const assetId = await makeAsset();
    const docId = await uploadTo(assetId);
    await as(request(server()).delete(`/api/v1/documents/${docId}`)).expect(204);
    const link = await as(request(server()).get(`/api/v1/documents/${docId}/download?as=link`));
    expect(link.status).toBe(404);

    await as(request(server()).delete(`/api/v1/assets/${assetId}`)).expect(204);
    const keeper = await makeAsset('Deleted just now');
    await as(request(server()).delete(`/api/v1/assets/${keeper}`)).expect(204);

    await age(DocumentModel as never, docId, 30);
    await age(AssetModel as never, assetId, 30);

    const counts = await runAsSystem({ requestId: 'test-purge', tenantId: t.tenantId, actorType: 'job' }, async () => {
      const { storageKey } = (await DocumentModel.findOne({ _id: docId }).setOptions({ withDeleted: true }).lean())!;
      const before = await getStorage().read(storageKey);
      const result = await purgeExpired();
      const after = await getStorage().read(storageKey);
      const remainingAssets = await AssetModel.countDocuments({ deletedAt: { $ne: null } });
      const remainingDocs = await DocumentModel.countDocuments({ deletedAt: { $ne: null } });
      const audit = await AuditLogModel.countDocuments({ action: 'recycle_bin.purged' });
      return { result, remainingAssets, remainingDocs, audit, before, after };
    });

    expect(counts.result).toMatchObject({ asset: 1, document: 1 });
    // The one deleted a moment ago is still restorable.
    expect(counts.remainingAssets).toBe(1);
    expect(counts.remainingDocs).toBe(0);
    expect(counts.audit).toBe(1);
    // The file really stayed while it was in the bin, and really went with the purge.
    expect(counts.before).not.toBeNull();
    expect(counts.after).toBeNull();
  });
});
