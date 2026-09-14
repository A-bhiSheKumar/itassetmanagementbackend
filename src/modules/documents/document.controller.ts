import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { getStorage, LocalStorageAdapter, attachmentDisposition } from '../../core/storage/index.js';
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
  const url = await service.downloadUrl(req.params.id!);

  /*
   * `?as=link` returns the signed URL instead of redirecting to it.
   *
   * The console fetches with a bearer token, and a fetch that follows a
   * redirect to S3 is a cross-origin request needing CORS on the bucket for a
   * read the browser could simply navigate to. Handing over the link lets the
   * browser download straight from storage. A plain link click still gets the
   * redirect.
   */
  if (req.query.as === 'link') {
    const record = await service.findDocument(req.params.id!);
    ok(res, { url, fileName: record.fileName, expiresInSeconds: 300 });
    return;
  }

  // 302 to a short-lived signed URL, issued only after the permission check
  // above has passed. There is no stable URL for a document.
  res.redirect(302, url);
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

  const { key, expires, signature, max } = req.query as Record<string, string>;
  const maxBytes = Number(max ?? 0);

  if (!key || !maxBytes || !storage.verify(key, Number(expires), signature ?? '', maxBytes)) {
    throw new ValidationError('That upload link is not valid or has expired.', {
      signature: ['Invalid.'],
    });
  }

  /*
   * Streamed with a hard cap, the way S3 enforces a POST policy.
   *
   * This used to buffer the entire request with no limit at all, so anyone
   * holding a valid link could send any number of bytes into the API's memory.
   * The cap is part of the signature, so it cannot be edited out of the URL.
   */
  const chunks: Buffer[] = [];
  let received = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    received += (chunk as Buffer).length;

    if (received > maxBytes) {
      tooLarge = true;
      // Nothing past the cap is kept. The remainder is drained rather than the
      // socket cut, so the client gets a readable 422 instead of "socket hang
      // up" — but only up to a ceiling, beyond which a client still sending is
      // not uploading a file by mistake.
      if (received > maxBytes + 1024 * 1024) {
        req.destroy();
        return;
      }
      continue;
    }

    chunks.push(chunk as Buffer);
  }

  if (tooLarge) {
    throw new ValidationError('That file is larger than the upload allows.', { sizeBytes: ['Too large.'] });
  }

  if (received === 0) {
    throw new ValidationError('No file was received.', { file: ['Empty upload.'] });
  }

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
  res.setHeader('Content-Disposition', attachmentDisposition(name ?? 'download'));
  res.send(body);
}
