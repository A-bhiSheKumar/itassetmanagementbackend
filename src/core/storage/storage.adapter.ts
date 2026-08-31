import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/index.js';

/**
 * Object storage behind an interface.
 *
 * Two implementations: S3-compatible for anything real, and a local filesystem
 * one so a developer can work without MinIO or AWS credentials. Call sites see
 * neither — which is also what makes swapping to R2 or GCS a config change.
 *
 * Keys are prefixed `t/{tenantId}/…` so a bucket policy can enforce isolation
 * as a second line of defence, and deleting a tenant is a prefix operation.
 */

export interface PresignedUpload {
  url: string;
  /** Set on the PUT by the client. */
  headers: Record<string, string>;
  key: string;
  expiresInSeconds: number;
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
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export function buildStorageKey(input: {
  tenantId: string;
  entityType: string;
  entityId: string;
  fileName: string;
}): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(input.fileName)?.[1]?.toLowerCase() ?? 'bin';
  // A random name, not the user's: filenames are attacker-controlled and would
  // otherwise let one upload overwrite another, or escape the prefix.
  const id = crypto.randomBytes(16).toString('hex');
  return `t/${input.tenantId}/${input.entityType}/${input.entityId}/${id}.${extension}`;
}

/**
 * Local filesystem storage for development and tests.
 *
 * Presigned URLs point at our own upload/download endpoints with a signed,
 * expiring token — the same shape as S3, so the client code is identical.
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
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`Refusing a storage key that escapes the root: ${key}`);
    }
    return resolved;
  }

  sign(key: string, expiresAt: number): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${key}:${expiresAt}`)
      .digest('base64url');
  }

  verify(key: string, expiresAt: number, signature: string): boolean {
    if (Date.now() > expiresAt) return false;

    const expected = this.sign(key, expiresAt);
    // Constant-time: a length or early-exit difference leaks the signature.
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async presignUpload(input: { key: string; contentType: string }): Promise<PresignedUpload> {
    const expiresAt = Date.now() + 5 * 60_000;
    const signature = this.sign(input.key, expiresAt);

    return {
      url: `/api/v1/documents/upload?key=${encodeURIComponent(input.key)}&expires=${expiresAt}&signature=${signature}`,
      headers: { 'Content-Type': input.contentType },
      key: input.key,
      expiresInSeconds: 300,
    };
  }

  async presignDownload(key: string, fileName: string): Promise<string> {
    const expiresAt = Date.now() + 5 * 60_000;
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
  // The S3 adapter lands with real credentials; the interface is what matters
  // now, so nothing above the adapter has to change when it does.
  adapter ??= new LocalStorageAdapter();
  return adapter;
}

export function setStorage(next: StorageAdapter): void {
  adapter = next;
}
