import type { Request, Response } from 'express';
import { ok, created, accepted } from '../../core/http/index.js';
import { ValidationError } from '../../core/errors/index.js';
import { definitionsFor } from '../catalog/index.js';
import type { ImportJobDocument } from './importJob.model.js';
import * as service from './import.service.js';
import { targetsFor } from './columnMapping.js';
import * as exports from './export.service.js';

function present(job: ImportJobDocument) {
  return {
    id: String(job._id),
    entityType: job.entityType,
    fileName: job.fileName,
    fileFormat: job.fileFormat,
    status: job.status,
    detectedHeaders: job.detectedHeaders,
    columnMapping: job.columnMapping,
    options: job.options,
    counts: job.counts,
    progress: job.progress,
    validatedAt: job.validatedAt,
    committedAt: job.committedAt,
    error: job.error,
    createdAt: job.createdAt,
  };
}

/**
 * Step 1: upload.
 *
 * The file arrives as a raw body rather than multipart — one file, no fields,
 * and multipart parsing is a dependency and an attack surface we do not need
 * for that.
 */
export async function create(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as {
    entityType: 'asset' | 'person';
    fileName: string;
    assetTypeId?: string;
  };

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks);

  if (content.length === 0) {
    throw new ValidationError('No file was received.', { file: ['Empty upload.'] });
  }

  const job = await service.createImport({
    entityType: query.entityType,
    fileName: query.fileName,
    content,
    assetTypeId: query.assetTypeId,
  });

  created(res, present(job));
}

export async function show(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.findImport(req.params.id!)));
}

export async function index(_req: Request, res: Response): Promise<void> {
  const jobs = await service.listImports();
  ok(res, jobs.map(present));
}

/** The fields a column can be mapped to, for the mapping UI. */
export async function targets(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { entityType: 'asset' | 'person'; assetTypeId?: string };

  const customFields = await definitionsFor({
    appliesTo: query.entityType,
    assetTypeId: query.assetTypeId ?? null,
  });

  ok(res, targetsFor(query.entityType, customFields));
}

export async function mapping(req: Request, res: Response): Promise<void> {
  const job = await service.updateMapping(req.params.id!, req.body as service.MappingInput);
  ok(res, present(job));
}

export async function validate(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.validateImport(req.params.id!)));
}

/**
 * Step 5: commit.
 *
 * Queued rather than run inline. A 5,000-row commit is minutes of work, and an
 * HTTP request is the wrong place to hold it — the client polls the job instead
 * and the user can close the tab (ADR-009).
 */
export async function commit(req: Request, res: Response): Promise<void> {
  const id = req.params.id!;
  const job = await service.findImport(id);

  if (job.status !== 'preview') {
    throw new ValidationError('Validate this import before committing it.', {
      status: [`Currently ${job.status}.`],
    });
  }

  const { queueImportCommit } = await import('./import.queue.js');
  await queueImportCommit(id, job.tenantId);

  accepted(res, {
    jobId: id,
    status: 'committing',
    statusUrl: `/api/v1/imports/${id}`,
  });
}

export async function cancel(req: Request, res: Response): Promise<void> {
  ok(res, present(await service.cancelImport(req.params.id!)));
}

export async function rows(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { status?: string; limit: number };

  // Resolve the job first. Querying rows directly is tenant-scoped and so
  // cannot leak, but it answers a foreign id with an empty 200 — which breaks
  // the rule that a record you cannot see is indistinguishable from one that
  // does not exist (ADR-015).
  await service.findImport(req.params.id!);

  const found = await service.importRows(req.params.id!, query);

  ok(
    res,
    found.map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      raw: row.raw,
      // Stored as `issues`; the API calls it `errors`, which is what a client expects.
      errors: row.issues,
      matchedEntityId: row.matchedEntityId,
      resultEntityId: row.resultEntityId,
    })),
  );
}

function sendCsv(res: Response, fileName: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(body);
}

export async function errorFile(req: Request, res: Response): Promise<void> {
  const id = req.params.id!;
  await service.findImport(id); // 404s for another tenant before any work.

  sendCsv(res, `import-${id}-errors.csv`, await exports.exportImportErrors(id));
}

export function template(req: Request, res: Response): void {
  const { entityType } = req.params as { entityType: 'asset' | 'person' };
  sendCsv(res, `${entityType}-import-template.csv`, exports.importTemplate(entityType));
}

export async function exportEntities(req: Request, res: Response): Promise<void> {
  const { entityType } = req.params as { entityType: 'asset' | 'person' };
  const date = new Date().toISOString().slice(0, 10);

  const body =
    entityType === 'asset'
      ? await exports.exportAssets(req.query as never)
      : await exports.exportPeople();

  sendCsv(res, `${entityType}s-${date}.csv`, body);
}
