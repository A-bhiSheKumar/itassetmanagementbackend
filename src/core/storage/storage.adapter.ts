import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/index.js';

/**
 * Object storage behind an interface.
 *
 * Two implementations: Amazon S3 for anything real, and a local filesystem one
 * so a developer can work without AWS credentials. Call sites see neither.
 *
 * ── Files never pass through the API ─────────────────────────────────────
 * Uploads go from the browser straight to storage on a presigned request, and
 * downloads are short-lived signed URLs. On Lambda this is not an optimisation
 * but a requirement: a synchronous invocation cannot carry more than 6 MB, and
 * every byte proxied through it is billed compute doing nothing.
 *
 * ── Keys ─────────────────────────────────────────────────────────────────
 * Durable files live under `t/{tenantId}/…`, so a bucket policy can enforce
 * isolation as a second line of defence and deleting a tenant is a prefix
 * operation. Short-lived files (import uploads, export downloads) live under
 * `transient/`, where one S3 lifecycle rule expires them — lifecycle rules match
 * from the START of a key, so the tenant cannot come first there.
 */

export interface PresignedUpload {
  /**
   * POST on S3, PUT locally.
   *
   * S3 is presigned as a POST because only a POST policy can carry a
   * `content-length-range`: a presigned PUT trusts whatever size the browser
   * declared and lets it upload anything. The local twin keeps PUT so it needs
   * no multipart parser, and enforces the size itself while streaming.
   */
  method: 'POST' | 'PUT';
  url: string;
  /** PUT: request headers to send. */
  headers: Record<string, string>;
  /** POST: form fields to send, in order, BEFORE the file field. */
  fields: Record<string, string>;
  key: string;
  expiresInSeconds: number;
  maxBytes: number;
}

export interface StoredObject {
  key: string;
  sizeBytes: number;
  etag?: string;
}

export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  presignUpload(input: { key: string; contentType: string; maxBytes: number }): Promise<PresignedUpload>;
  presignDownload(key: string, fileName: string): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
  /** First N bytes, for magic-byte verification without a full download. */
  readHead(key: string, bytes: number): Promise<Buffer | null>;
  /** The whole object. For server-side parsing of an uploaded import. */
  read(key: string): Promise<Buffer | null>;
  /** Writes an object the server generated — an export file. */
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

const UPLOAD_TTL_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

export function buildStorageKey(input: {
  tenantId: string;
  entityType: string;
  entityId: string;
  fileName: string;
}): string {
  // A random name, not the user's: filenames are attacker-controlled and would
  // otherwise let one upload overwrite another, or escape the prefix.
  return `t/${input.tenantId}/${input.entityType}/${input.entityId}/${randomName(input.fileName)}`;
}

/** Keys for short-lived files, expired by a lifecycle rule on `transient/`. */
export function buildTransientKey(input: { kind: 'imports' | 'exports'; tenantId: string; fileName: string }): string {
  return `transient/${input.kind}/t/${input.tenantId}/${randomName(input.fileName)}`;
}

function randomName(fileName: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? 'bin';
  return `${crypto.randomBytes(16).toString('hex')}.${extension}`;
}

/**
 * A Content-Disposition that is always an attachment and safe to emit.
 *
 * Quotes and control characters are stripped from the plain form, and the
 * RFC 5987 form carries the real (possibly non-ASCII) name. Always attachment:
 * an inline render of an attacker-supplied file executes in our origin.
 */
export function attachmentDisposition(fileName: string): string {
  const plain = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 150) || 'download';
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(fileName.slice(0, 150))}`;
}

// ── Amazon S3 ────────────────────────────────────────────────────────────────

export class S3StorageAdapter implements StorageAdapter {
  readonly kind = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static fromEnv(): S3StorageAdapter {
    const client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      // Only when explicitly configured (MinIO, a laptop). On Lambda the IAM
      // role's credentials are picked up automatically, which is the point.
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
        : {}),
    });
    return new S3StorageAdapter(client, env.S3_BUCKET!);
  }

  async presignUpload(input: { key: string; contentType: string; maxBytes: number }): Promise<PresignedUpload> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: input.key,
      Conditions: [
        // The reason this is a POST: S3 itself refuses anything outside the
        // range, whatever the browser claimed at presign time.
        ['content-length-range', 1, input.maxBytes],
        ['eq', '$Content-Type', input.contentType],
      ],
      Fields: { 'Content-Type': input.contentType },
      Expires: UPLOAD_TTL_SECONDS,
    });

    return {
      method: 'POST',
      url,
      headers: {},
      fields,
      key: input.key,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
      maxBytes: input.maxBytes,
    };
  }

  presignDownload(key: string, fileName: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Forced on the response, not trusted from the object: what was uploaded
        // as a PDF is still served as an opaque attachment.
        ResponseContentDisposition: attachmentDisposition(fileName),
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS },
    );
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, sizeBytes: result.ContentLength ?? 0, etag: result.ETag };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer | null> {
    return this.get(key, `bytes=0-${bytes - 1}`);
  }

  read(key: string): Promise<Buffer | null> {
    return this.get(key);
  }

  private async get(key: string, range?: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: range } : {}) }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;

    // Paged: a tenant with a hundred thousand documents does not fit in one
    // listing, and DeleteObjects takes at most a thousand keys a call.
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));

      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }

      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return deleted;
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

// ── Local filesystem ─────────────────────────────────────────────────────────

/**
 * Local filesystem storage for development and tests.
 *
 * Presigned URLs point at our own upload/download endpoints with an expiring
 * HMAC signature — the same trust model as a presigned S3 URL, so the flow and
 * the authorisation are identical even though the transport differs.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly secret: string;

  constructor(root = path.join(process.cwd(), '.storage'), secret = env.JWT_ACCESS_SECRET) {
    this.root = root;
    this.secret = secret;
  }

  private full(key: string): string {
    // Refuse anything that could climb out of the storage root.
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Refusing a storage key that escapes the root: ${key}`);
    }
    return resolved;
  }

  /**
   * The size limit is INSIDE the signature, so a client cannot raise it by
   * editing the URL — the local equivalent of S3's POST policy.
   */
  sign(key: string, expiresAt: number, maxBytes = 0): string {
    return crypto.createHmac('sha256', this.secret).update(`${key}:${expiresAt}:${maxBytes}`).digest('base64url');
  }

  verify(key: string, expiresAt: number, signature: string, maxBytes = 0): boolean {
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

    const expected = Buffer.from(this.sign(key, expiresAt, maxBytes));
    const given = Buffer.from(signature);
    // Constant-time: a length or early-exit difference leaks the signature.
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  async presignUpload(input: { key: string; contentType: string; maxBytes: number }): Promise<PresignedUpload> {
    const expiresAt = Date.now() + UPLOAD_TTL_SECONDS * 1000;
    const signature = this.sign(input.key, expiresAt, input.maxBytes);

    return {
      method: 'PUT',
      url: `/api/v1/documents/upload?key=${encodeURIComponent(input.key)}&expires=${expiresAt}&max=${input.maxBytes}&signature=${signature}`,
      headers: { 'Content-Type': input.contentType },
      fields: {},
      key: input.key,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
      maxBytes: input.maxBytes,
    };
  }

  async presignDownload(key: string, fileName: string): Promise<string> {
    const expiresAt = Date.now() + DOWNLOAD_TTL_SECONDS * 1000;
    const signature = this.sign(key, expiresAt);
    return `/api/v1/documents/download?key=${encodeURIComponent(key)}&expires=${expiresAt}&signature=${signature}&name=${encodeURIComponent(fileName)}`;
  }

  async write(key: string, body: Buffer): Promise<void> {
    const target = this.full(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.full(key));
    } catch {
      return null;
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const stat = await fs.stat(this.full(key));
      return { key, sizeBytes: stat.size };
    } catch {
      return null;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer | null> {
    const handle = await fs.open(this.full(key), 'r').catch(() => null);
    if (!handle) return null;

    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.full(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const target = this.full(prefix);
    const before = await countFiles(target);
    await fs.rm(target, { recursive: true, force: true });
    return before;
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
    }
    return count;
  } catch {
    return 0;
  }
}

let adapter: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  adapter ??= env.STORAGE_DRIVER === 's3' ? S3StorageAdapter.fromEnv() : new LocalStorageAdapter();
  return adapter;
}

export function setStorage(next: StorageAdapter | undefined): void {
  adapter = next;
}
