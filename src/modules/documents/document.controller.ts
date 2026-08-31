import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { getStorage, LocalStorageAdapter } from '../../core/storage/index.js';
import { formatBytes } from '../../shared/format.js';
import type { DocumentRecordDocument } from './document.model.js';
import * as service from './document.service.js';

function present(doc: DocumentRecordDocument) {
  return {
    id: String(doc._id),
    entityType: doc.entityType,
    entityId: doc.entityId,
    category: doc.category,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    sizeLabel: formatBytes(doc.sizeBytes),
    status: doc.status,
    uploadedBy: doc.uploadedBy,
    createdAt: doc.createdAt,
  };
}

export async function presign(req: Request, res: Response): Promise<void> {
  const result = await service.presignUpload(req.body as service.PresignInput);
  created(res, result);
}

export async function confirm(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.confirmUpload(req.params.id!)));
}

export async function index(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { entityType: string; entityId: string };
  const docs = await service.listDocuments(query.entityType, query.entityId);
  ok(res, docs.map(present));
}

export async function download(req: Request, res: Response): Promise<void> {
  // 302 to a short-lived signed URL, issued only after the permission check
  // above has passed. There is no stable URL for a document.
  res.redirect(302, await service.downloadUrl(req.params.id!));
}

export async function destroy(req: Request, res: Response): Promise<void> {
  await service.deleteDocument(req.params.id!);
  noContent(res);
}

/**
 * Local-storage upload and download endpoints.
 *
 * These stand in for S3's presigned PUT/GET when no object store is configured,
 * so a developer can work without MinIO. Authorised by the signature in the URL
 * — the same trust model as a presigned S3 URL — which is why they are public
 * routes rather than token-authenticated ones.
 */
export async function localUpload(req: Request, res: Response): Promise<void> {
  const storage = getStorage();
  if (!(storage instanceof LocalStorageAdapter)) throw new NotFoundError('Route');

  const { key, expires, signature } = req.query as Record<string, string>;

  if (!key || !storage.verify(key, Number(expires), signature ?? '')) {
    throw new ValidationError('That upload link is not valid or has expired.', {
      signature: ['Invalid.'],
    });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  await storage.write(key, Buffer.concat(chunks));
  noContent(res);
}

export async function localDownload(req: Request, res: Response): Promise<void> {
  const storage = getStorage();
  if (!(storage instanceof LocalStorageAdapter)) throw new NotFoundError('Route');

  const { key, expires, signature, name } = req.query as Record<string, string>;

  if (!key || !storage.verify(key, Number(expires), signature ?? '')) {
    throw new NotFoundError('File');
  }

  const body = await storage.read(key);
  if (!body) throw new NotFoundError('File');

  // Always an attachment, never inline: an inline render of an attacker-
  // supplied file executes in our origin.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(name ?? 'download').replace(/"/g, '')}"`);
  res.send(body);
}
