import { NotFoundError, ValidationError, EntitlementExceededError } from '../../core/errors/index.js';
import { getContext } from '../../core/context/index.js';
import { logger } from '../../core/logging/index.js';
import {
  getStorage,
  buildStorageKey,
  verifyMagicBytes,
  extensionOf,
  ALLOWED_EXTENSIONS,
} from '../../core/storage/index.js';
import { resolveEntitlements, getUsage, TenantUsageModel } from '../subscriptions/index.js';
import { DocumentModel, type DocumentRecordDocument } from './document.model.js';

/** Generous enough for a scanned invoice, small enough to bound abuse. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** How long an unconfirmed upload survives before the sweeper removes it. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PresignInput {
  entityType: string;
  entityId: string;
  fileName: string;
  sizeBytes: number;
  category?: string;
}

/**
 * Step one of an upload: reserve a key and hand back a presigned URL.
 *
 * The file goes straight to object storage; it never passes through the API.
 * That keeps a 25 MB upload off our event loop and out of our memory.
 */
export async function presignUpload(input: PresignInput): Promise<{
  documentId: string;
  upload: Awaited<ReturnType<ReturnType<typeof getStorage>['presignUpload']>>;
}> {
  const extension = extensionOf(input.fileName);

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ValidationError(`.${extension || 'unknown'} files are not accepted.`, {
      fileName: ['That file type is not accepted.'],
    });
  }

  if (input.sizeBytes > MAX_FILE_BYTES) {
    throw new ValidationError(`Files must be under ${MAX_FILE_BYTES / 1024 / 1024} MB.`, {
      sizeBytes: ['Too large.'],
    });
  }

  await assertStorageAvailable(input.sizeBytes);

  const ctx = getContext();
  const storageKey = buildStorageKey({
    tenantId: ctx!.tenantId!,
    entityType: input.entityType,
    entityId: input.entityId,
    fileName: input.fileName,
  });

  const record = await DocumentModel.create({
    entityType: input.entityType,
    entityId: input.entityId,
    category: input.category ?? 'other',
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    storageKey,
    status: 'pending',
    uploadedBy: ctx?.userId ?? null,
  });

  const upload = await getStorage().presignUpload({
    key: storageKey,
    contentType: 'application/octet-stream',
    maxBytes: MAX_FILE_BYTES,
  });

  return { documentId: String(record._id), upload };
}

/**
 * Step two: verify what actually arrived.
 *
 * The client says the upload finished; that claim is worth nothing on its own.
 * We check the object exists, measure its real size, and read its first bytes
 * to confirm the contents match the extension. Only then does it become
 * downloadable — and only then does it count against the storage quota.
 */
export async function confirmUpload(documentId: string): Promise<DocumentRecordDocument> {
  const record = await DocumentModel.findById(documentId).exec();
  if (!record) throw new NotFoundError('Document');

  if (record.status === 'ready') return record;

  const storage = getStorage();
  const object = await storage.head(record.storageKey);

  if (!object) {
    throw new ValidationError('That upload did not complete. Try again.', {
      upload: ['Nothing was received.'],
    });
  }

  if (object.sizeBytes > MAX_FILE_BYTES) {
    await reject(record, 'The uploaded file is larger than the limit.');
    throw new ValidationError('That file is too large.', { sizeBytes: ['Too large.'] });
  }

  // The declared size was a hint; this is the truth, and it is what we bill for.
  record.sizeBytes = object.sizeBytes;

  const head = await storage.readHead(record.storageKey, 64);
  const verification = verifyMagicBytes(record.fileName, head ?? Buffer.alloc(0));

  if (!verification.ok) {
    // Renaming an executable to invoice.pdf changes the declared type and
    // nothing else. This is the check that notices.
    await reject(record, verification.reason ?? 'The file contents are not valid.');
    logger.warn(
      { documentId, fileName: record.fileName, reason: verification.reason },
      'Rejected an upload whose contents did not match its extension',
    );
    throw new ValidationError(verification.reason ?? 'That file is not valid.', {
      fileName: ['Contents do not match the file type.'],
    });
  }

  record.contentType = verification.detectedMime;
  record.status = 'ready';
  await record.save();

  // Counted only now — a reserved-but-never-uploaded file must not consume
  // someone's quota.
  await addStorageBytes(object.sizeBytes);

  return record;
}

async function reject(record: DocumentRecordDocument, reason: string): Promise<void> {
  record.status = 'rejected';
  record.rejectionReason = reason;
  await record.save();
  // Nothing usable is kept: a rejected file is a liability, not an artefact.
  await getStorage().delete(record.storageKey);
}

export async function listDocuments(entityType: string, entityId: string) {
  return DocumentModel.find({ entityType, entityId, status: 'ready' })
    .sort({ createdAt: -1 })
    .exec();
}

/**
 * Download is always a short-lived signed URL issued AFTER an authorization
 * check. There is no stable URL for a document, and the bucket is never public.
 */
export async function downloadUrl(documentId: string): Promise<string> {
  const record = await DocumentModel.findById(documentId).exec();
  if (!record) throw new NotFoundError('Document');

  if (record.status !== 'ready') {
    throw new ValidationError('That file is not available.', { status: [record.status] });
  }

  return getStorage().presignDownload(record.storageKey, record.fileName);
}

export async function deleteDocument(documentId: string): Promise<void> {
  const record = await DocumentModel.findById(documentId).exec();
  if (!record) throw new NotFoundError('Document');

  await getStorage().delete(record.storageKey);
  await record.softDelete();
  await addStorageBytes(-record.sizeBytes);
}

async function assertStorageAvailable(additionalBytes: number): Promise<void> {
  const { entitlements } = await resolveEntitlements();
  const limit = entitlements.storageBytes;
  if (limit === null || limit === undefined) return;

  const { usage } = await getUsage();
  const used = usage.storageBytes ?? 0;

  if (used + additionalBytes > limit) {
    // Refused at presign, before anything is uploaded — failing after a 25 MB
    // transfer would be rude and pointless.
    throw new EntitlementExceededError('storage', limit, used);
  }
}

async function addStorageBytes(delta: number): Promise<void> {
  await TenantUsageModel.updateOne({}, { $inc: { storageBytes: delta } }, { upsert: true });
}

/**
 * Removes uploads that were reserved but never confirmed.
 *
 * Without this, every abandoned upload leaves a row claiming a file that does
 * not exist, and an object nobody will ever reference.
 */
export async function sweepAbandonedUploads(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_TTL_MS);

  const stale = await DocumentModel.find({ status: 'pending', createdAt: { $lt: cutoff } })
    .limit(500)
    .exec();

  for (const record of stale) {
    await getStorage().delete(record.storageKey);
    await record.softDelete();
  }

  if (stale.length > 0) {
    logger.info({ count: stale.length }, 'Swept abandoned uploads');
  }

  return stale.length;
}
