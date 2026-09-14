import { describe, it, expect } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant } from '../helpers/factories.js';
import { S3StorageAdapter, attachmentDisposition, buildTransientKey } from '../../src/core/storage/index.js';
import { envSchema } from '../../src/config/env.js';

const server = useTestServer(createApp());

/**
 * The guarantees that make uploads safe to leave unattended, asserted directly.
 * None of these are about the happy path — the upload flow itself is covered in
 * the documents and imports suites.
 */

describe('S3 presigned uploads', () => {
  // Signed locally with fixed credentials: no network, no AWS account.
  const adapter = new S3StorageAdapter(
    new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } }),
    'itam-files-test',
  );

  it('is a POST whose policy makes S3 itself enforce the size limit', async () => {
    const upload = await adapter.presignUpload({
      key: 't/abc/asset/1/file.pdf',
      contentType: 'application/octet-stream',
      maxBytes: 25 * 1024 * 1024,
    });

    expect(upload.method).toBe('POST');

    // The policy is what S3 checks, whatever the browser claims.
    const policy = JSON.parse(Buffer.from(upload.fields.Policy!, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 25 * 1024 * 1024]);
    expect(policy.conditions).toContainEqual({ key: 't/abc/asset/1/file.pdf' });
    expect(policy.conditions).toContainEqual({ bucket: 'itam-files-test' });
  });

  it('signs downloads as attachments, never inline', async () => {
    const url = await adapter.presignDownload('t/abc/asset/1/file.pdf', 'invoice.pdf');
    const params = new URL(url).searchParams;

    expect(params.get('response-content-disposition')).toMatch(/^attachment;/);
    expect(params.get('response-content-type')).toBe('application/octet-stream');
    expect(Number(params.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
  });
});

describe('attachment filenames', () => {
  it('cannot break out of the header', () => {
    const header = attachmentDisposition('evil"\r\nSet-Cookie: x=1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('"')).toHaveLength(3); // exactly one quoted value
  });

  it('keeps a non-ASCII name readable through the RFC 5987 form', () => {
    expect(attachmentDisposition('Rechnung-Ü.pdf')).toContain("filename*=UTF-8''Rechnung-%C3%9C.pdf");
  });
});

describe('transient keys', () => {
  it('start with transient/, so one lifecycle rule can expire them', () => {
    expect(buildTransientKey({ kind: 'exports', tenantId: 'abc', fileName: 'assets.csv' })).toMatch(
      /^transient\/exports\/t\/abc\/[0-9a-f]{32}\.csv$/,
    );
  });
});

describe('the local upload endpoint', () => {
  async function presignImport(sizeBytes: number) {
    await ensurePlansSeeded();
    const t = await seedTenant(server(), `storage-${Math.random().toString(36).slice(2, 7)}`);
    const res = await request(server())
      .post('/api/v1/imports/uploads')
      .set('Authorization', `Bearer ${t.accessToken}`)
      .send({ fileName: 'assets.csv', sizeBytes });
    return { t, ...(res.body.data as { uploadKey: string; upload: { url: string; maxBytes: number } }) };
  }

  it('stops reading once the signed size cap is exceeded', async () => {
    const { upload } = await presignImport(10);
    // A valid link does not license an unlimited body — the old endpoint
    // buffered whatever arrived, with no limit at all.
    const tooBig = Buffer.alloc(upload.maxBytes + 1, 0x61);

    const res = await request(server()).put(upload.url).send(tooBig);
    expect(res.status).toBe(422);
  });

  it('rejects a link whose size cap was edited', async () => {
    const { upload } = await presignImport(10);
    const raised = upload.url.replace(/max=\d+/, 'max=999999999999');

    const res = await request(server()).put(raised).send(Buffer.from('a,b\n1,2'));
    expect(res.status).toBe(422);
  });

  it("will not stage another organisation's upload", async () => {
    const owner = await presignImport(10);
    await request(server()).put(owner.upload.url).send(Buffer.from('Name\nLaptop')).expect(204);

    const intruder = await seedTenant(server(), 'storage-intruder');
    const res = await request(server())
      .post('/api/v1/imports')
      .set('Authorization', `Bearer ${intruder.accessToken}`)
      .send({ uploadKey: owner.uploadKey, entityType: 'person', fileName: 'assets.csv' });

    // 404, not 403: no confirmation that the file exists (ADR-015).
    expect(res.status).toBe(404);
  });
});

describe('configuration', () => {
  const base = {
    MONGO_URI: 'mongodb://x',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };

  it('refuses the local driver in production, where uploads would be silently lost', () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 'local' });
    expect(result.success).toBe(false);
  });

  it('requires a bucket and region for S3', () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 's3' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('S3_BUCKET');
  });

  const production = {
    ...base,
    NODE_ENV: 'production',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'itam-files',
    S3_REGION: 'ap-south-1',
    RESEND_API_KEY: 're_test',
    RESEND_WEBHOOK_SECRET: 'whsec_dGVzdA==',
    MAIL_FROM: 'IT Assets <notifications@updates.example.com>',
    APP_URL: 'https://assets.example.com',
  };

  it('accepts a complete production configuration', () => {
    const result = envSchema.safeParse(production);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each([
    ['no Resend key', { RESEND_API_KEY: undefined }],
    ['no webhook secret, so bounces are never suppressed', { RESEND_WEBHOOK_SECRET: undefined }],
    ['the Resend test sender', { MAIL_FROM: 'Test <onboarding@resend.dev>' }],
    ['links to plain http', { APP_URL: 'http://assets.example.com' }],
    ['a development redirect left on', { MAIL_REDIRECT_TO: 'dev@example.com' }],
  ])('refuses production email with %s', (_label, override) => {
    expect(envSchema.safeParse({ ...production, ...override }).success).toBe(false);
  });
});
