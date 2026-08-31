import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;
let assetId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

/** Real file headers — the point of the exercise is the bytes, not the name. */
const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), Buffer.alloc(64)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
/** A Mach-O executable header. Renaming it changes nothing about what it is. */
const MACHO = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(64)]);

async function upload(fileName: string, bytes: Buffer) {
  const presigned = await as(
    request(server()).post('/api/v1/documents/presign').send({
      entityType: 'asset',
      entityId: assetId,
      fileName,
      sizeBytes: bytes.length,
      category: 'invoice',
    }),
  );

  if (presigned.status !== 201) return { presigned, put: null, confirm: null };

  // Straight to storage, exactly as an S3 presigned PUT would be — the bytes
  // never pass through the API.
  const put = await request(server())
    .put(presigned.body.data.upload.url.replace('/api/v1', '/api/v1'))
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);

  const confirm = await as(
    request(server()).post(`/api/v1/documents/${presigned.body.data.documentId}/confirm`),
  );

  return { presigned, put, confirm };
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'docs');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  const laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;

  const asset = await as(
    request(server())
      .post('/api/v1/assets')
      .send({ name: 'Laptop', assetTypeId: laptopTypeId, serialNumber: `SN-${Date.now()}` }),
  );
  assetId = asset.body.data.id;
});

describe('uploading', () => {
  it('presigns, uploads and confirms a real PDF', async () => {
    const { presigned, put, confirm } = await upload('invoice.pdf', PDF);

    expect(presigned.status).toBe(201);
    expect(put!.status).toBe(204);
    expect(confirm!.status).toBe(200);
    expect(confirm!.body.data.status).toBe('ready');
    // Detected from the bytes, not taken from the request.
    expect(confirm!.body.data.contentType).toBe('application/pdf');
  });

  it('records the real size, not the declared one', async () => {
    const presigned = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'photo.png',
        sizeBytes: 10, // a lie
      }),
    );

    await request(server())
      .put(presigned.body.data.upload.url)
      .set('Content-Type', 'application/octet-stream')
      .send(PNG);

    const confirm = await as(
      request(server()).post(`/api/v1/documents/${presigned.body.data.documentId}/confirm`),
    );

    // The declared size was a hint; this is what we store and what we bill for.
    expect(confirm.body.data.sizeBytes).toBe(PNG.length);
  });

  it('rejects an executable renamed as a PDF', async () => {
    // The whole reason magic bytes are checked. Renaming payload.bin to
    // invoice.pdf changes the declared type and nothing else.
    const { confirm } = await upload('invoice.pdf', MACHO);

    expect(confirm!.status).toBe(422);
    expect(confirm!.body.error.fields.fileName).toBeDefined();
  });

  it('rejects a file type that is not on the allowlist', async () => {
    const res = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'script.sh',
        sizeBytes: 100,
      }),
    );

    // Refused at presign, before a single byte is transferred.
    expect(res.status).toBe(422);
  });

  it('rejects SVG even though it is an image', async () => {
    // SVG is XML, can carry script, and served inline would execute in our
    // origin. Not worth the CSP work it would need.
    const res = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'logo.svg',
        sizeBytes: 100,
      }),
    );

    expect(res.status).toBe(422);
  });

  it('rejects an oversized file at presign', async () => {
    const res = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'huge.pdf',
        sizeBytes: 100 * 1024 * 1024,
      }),
    );

    expect(res.status).toBe(422);
  });

  it('keeps a rejected file out of the listing', async () => {
    await upload('invoice.pdf', MACHO);

    const listed = await as(
      request(server()).get(`/api/v1/documents?entityType=asset&entityId=${assetId}`),
    );

    expect(listed.body.data).toHaveLength(0);
  });
});

describe('the upload URL', () => {
  it('refuses a tampered signature', async () => {
    const presigned = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'invoice.pdf',
        sizeBytes: PDF.length,
      }),
    );

    const tampered = presigned.body.data.upload.url.replace(/signature=[^&]+/, 'signature=forged');
    const res = await request(server()).put(tampered).send(PDF);

    expect(res.status).toBe(422);
  });

  it('refuses an expired link', async () => {
    const presigned = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'invoice.pdf',
        sizeBytes: PDF.length,
      }),
    );

    const expired = presigned.body.data.upload.url.replace(/expires=\d+/, 'expires=1');
    const res = await request(server()).put(expired).send(PDF);

    expect(res.status).toBe(422);
  });

  it('will not let a key climb out of the storage root', async () => {
    const res = await request(server())
      .put('/api/v1/documents/upload?key=../../../etc/passwd&expires=9999999999999&signature=x')
      .send(Buffer.from('nope'));

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('downloading', () => {
  it('redirects to a short-lived signed URL', async () => {
    const { confirm } = await upload('invoice.pdf', PDF);

    const res = await as(request(server()).get(`/api/v1/documents/${confirm!.body.data.id}/download`));

    // Never a stable URL: the link is issued only after the permission check.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('signature=');
  });

  it('serves the file as an attachment, never inline', async () => {
    const { confirm } = await upload('invoice.pdf', PDF);
    const redirect = await as(request(server()).get(`/api/v1/documents/${confirm!.body.data.id}/download`));

    const file = await request(server()).get(redirect.headers.location!);

    expect(file.status).toBe(200);
    // Inline rendering of an attacker-supplied file executes in our origin.
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.headers['content-type']).toContain('application/octet-stream');
  });

  it('refuses a download with no valid signature', async () => {
    const res = await request(server()).get('/api/v1/documents/download?key=whatever&expires=1&signature=x');
    expect(res.status).toBe(404);
  });
});

describe('storage accounting', () => {
  it('counts a file only once it is confirmed', async () => {
    const before = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(before.body.data.usage.storageBytes).toBe(0);

    const presigned = await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'invoice.pdf',
        sizeBytes: PDF.length,
      }),
    );

    // Reserved but not uploaded — must not consume anyone's quota.
    const reserved = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(reserved.body.data.usage.storageBytes).toBe(0);

    await request(server()).put(presigned.body.data.upload.url).send(PDF);
    await as(request(server()).post(`/api/v1/documents/${presigned.body.data.documentId}/confirm`));

    const after = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(after.body.data.usage.storageBytes).toBe(PDF.length);
  });

  it('gives the space back on delete', async () => {
    const { confirm } = await upload('invoice.pdf', PDF);

    await as(request(server()).delete(`/api/v1/documents/${confirm!.body.data.id}`)).expect(204);

    const usage = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(usage.body.data.usage.storageBytes).toBe(0);
  });
});

describe('the abandoned-upload sweeper', () => {
  it('removes uploads that were reserved but never confirmed', async () => {
    const { sweepAbandonedUploads, DocumentModel } = await import(
      '../../src/modules/documents/index.js'
    );
    const { runAsSystem } = await import('../../src/core/context/index.js');

    await as(
      request(server()).post('/api/v1/documents/presign').send({
        entityType: 'asset',
        entityId: assetId,
        fileName: 'never-arrived.pdf',
        sizeBytes: 100,
      }),
    ).expect(201);

    // A background job runs under a synthetic tenant context, exactly as the
    // scheduler gives it one — the tenant plugin applies to jobs as it does to
    // requests, and refuses a query without it.
    const swept = await runAsSystem({ requestId: 'test-sweep', tenantId: t.tenantId }, async () => {
      // Raw collection: mongoose marks `createdAt` immutable under
      // `timestamps: true`, so a model-level $set is silently dropped. Going
      // round it is right for a fixture that needs to fake the passage of time.
      await DocumentModel.collection.updateOne(
        { tenantId: t.tenantId, status: 'pending' },
        { $set: { createdAt: new Date(Date.now() - 48 * 3_600_000) } },
      );

      const count = await sweepAbandonedUploads();
      const remaining = await DocumentModel.countDocuments({ status: 'pending' });
      return { count, remaining };
    });

    expect(swept.count).toBe(1);
    expect(swept.remaining).toBe(0);
  });
});
