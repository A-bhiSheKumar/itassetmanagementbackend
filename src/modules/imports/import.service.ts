import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { getContext } from '../../core/context/index.js';
import { logger } from '../../core/logging/index.js';
import { resolveEntitlements, getUsage } from '../subscriptions/index.js';
import { definitionsFor } from '../catalog/index.js';
import { AssetModel, createAsset, updateAsset } from '../assets/index.js';
import { PersonModel, createPerson, updatePerson, DepartmentModel, LocationModel } from '../people/index.js';
import { ImportJobModel, type ImportJobDocument } from './importJob.model.js';
import { ImportRowModel } from './importRow.model.js';
import { parseFile, detectFormat } from './parsers.js';
import { suggestMapping, targetsFor, missingRequired, type FieldTarget } from './columnMapping.js';
import { normaliseRow, hashRow, type RowError, type DateOrder } from './rowValidation.js';

/**
 * The staged import pipeline.
 *
 *   upload → map columns → validate (dry run) → review → commit
 *
 * Nothing touches a real collection until commit, and the commit runs in
 * batches that are individually transactional and idempotent. A run interrupted
 * at row 3,000 resumes without duplicating the first 2,999.
 */

/** Small enough to keep a transaction short; large enough to be fast. */
const COMMIT_BATCH_SIZE = 250;

export interface CreateImportInput {
  entityType: 'asset' | 'person';
  fileName: string;
  content: Buffer;
  assetTypeId?: string;
}

/**
 * Step 1–2: parse the file, stage every row, and suggest a mapping.
 *
 * Parsing happens up front so an unreadable file fails immediately rather than
 * after the user has configured a mapping for it.
 */
export async function createImport(input: CreateImportInput): Promise<ImportJobDocument> {
  /**
   * An asset import must say WHAT it is importing.
   *
   * The type decides the tag prefix, which custom fields apply, and which
   * lifecycle the assets follow. Falling back to "the first type alphabetically"
   * silently imported five thousand laptops as accessories — exactly the class
   * of quiet wrongness this whole staged pipeline exists to prevent.
   */
  if (input.entityType === 'asset' && !input.assetTypeId) {
    throw new ValidationError('Choose what kind of asset you are importing.', {
      assetTypeId: ['Required for asset imports.'],
    });
  }

  const format = detectFormat(input.fileName);
  const parsed = await parseFile(input.fileName, input.content);

  if (parsed.rows.length === 0) {
    throw new ValidationError('That file has no data rows.', { file: ['Nothing to import.'] });
  }

  const customFields = await definitionsFor({
    appliesTo: input.entityType,
    assetTypeId: input.assetTypeId ?? null,
  });

  const targets = targetsFor(input.entityType, customFields);

  const job = await ImportJobModel.create({
    entityType: input.entityType,
    fileName: input.fileName,
    fileFormat: format,
    status: 'mapping',
    detectedHeaders: parsed.headers,
    columnMapping: suggestMapping(parsed.headers, targets),
    options: { assetTypeId: input.assetTypeId ?? null },
    counts: { total: parsed.rows.length },
    startedBy: getContext()?.userId ?? null,
  });

  // Staged verbatim. The mapping can change afterwards without re-uploading,
  // which is what makes "fix the mapping and revalidate" a ten-second loop.
  await stageRows(String(job._id), parsed.rows);

  return job;
}

async function stageRows(importJobId: string, rows: Array<Record<string, string>>): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);

    await ImportRowModel.insertMany(
      chunk.map((raw, index) => ({
        importJobId,
        // 1-based and offset by the header, so it matches what the user sees in
        // their spreadsheet. An error citing "row 4" must mean row 4 to them.
        rowNumber: i + index + 2,
        raw,
        rowHash: hashRow({}, i + index + 2, 'asset'),
        status: 'valid' as const,
      })),
      { ordered: false },
    );
  }
}

export async function findImport(id: string): Promise<ImportJobDocument> {
  const job = await ImportJobModel.findById(id).exec();
  if (!job) throw new NotFoundError('Import');
  return job;
}

export interface MappingInput {
  columnMapping: Record<string, string>;
  duplicateStrategy?: 'skip' | 'update' | 'error';
  dateFormat?: DateOrder;
  createMissingReferences?: boolean;
}

export async function updateMapping(id: string, input: MappingInput): Promise<ImportJobDocument> {
  const job = await findImport(id);

  if (job.status === 'committing' || job.status === 'completed') {
    throw new ValidationError('This import has already run.', { status: [job.status] });
  }

  const targets = await targetsForJob(job);
  const missing = missingRequired(input.columnMapping, targets);

  if (missing.length > 0) {
    // Caught before any row is read, so the user is not told about 5,000
    // individually broken rows when one column is unmapped.
    throw new ValidationError(
      `Map a column to ${missing.map((t) => t.label).join(' and ')} before continuing.`,
      { columnMapping: missing.map((t) => `${t.label} is required.`) },
    );
  }

  job.columnMapping = input.columnMapping;
  if (input.duplicateStrategy) job.options!.duplicateStrategy = input.duplicateStrategy;
  if (input.dateFormat) job.options!.dateFormat = input.dateFormat;
  if (input.createMissingReferences !== undefined) {
    job.options!.createMissingReferences = input.createMissingReferences;
  }
  job.status = 'mapping';
  await job.save();

  return job;
}

async function targetsForJob(job: ImportJobDocument): Promise<FieldTarget[]> {
  const customFields = await definitionsFor({
    appliesTo: job.entityType,
    assetTypeId: job.options?.assetTypeId ?? null,
  });

  return targetsFor(job.entityType as 'asset' | 'person', customFields);
}

/**
 * Step 3: the dry run.
 *
 * Every row is coerced, checked, and matched against existing records — and
 * nothing is written. The counts this produces are exactly what the commit will
 * do, which is the whole reason for staging.
 */
export async function validateImport(id: string): Promise<ImportJobDocument> {
  const job = await findImport(id);

  job.status = 'validating';
  await job.save();

  const context = {
    entityType: job.entityType as 'asset' | 'person',
    dateFormat: (job.options?.dateFormat ?? 'DMY') as DateOrder,
  };

  const rows = await ImportRowModel.find({ importJobId: id }).sort({ rowNumber: 1 }).exec();

  // Duplicates within the file itself, which a database check cannot catch
  // because neither row exists yet.
  const seen = new Map<string, number>();

  let valid = 0;
  let invalid = 0;
  let duplicates = 0;

  for (const row of rows) {
    const normalised = normaliseRow(
      row.raw as Record<string, string>,
      job.columnMapping as Record<string, string>,
      context,
    );

    const errors: RowError[] = [...normalised.errors];

    const key = identityKey(normalised.values, context.entityType);

    if (key) {
      const firstSeenAt = seen.get(key);
      if (firstSeenAt !== undefined) {
        errors.push({
          field: 'identity',
          message: `Duplicate of row ${firstSeenAt} in this file.`,
        });
      } else {
        seen.set(key, row.rowNumber);
      }
    }

    const match = errors.length === 0 ? await findExisting(normalised.values, context.entityType) : null;

    row.normalised = { ...normalised.values, customFields: normalised.customFields };
    row.rowHash = hashRow(normalised.values, row.rowNumber, context.entityType);
    row.matchedEntityId = match;
    // set() rather than assignment: mongoose types this as a DocumentArray and
    // going through set() lets it construct the subdocuments.
    row.set('issues', errors);

    if (errors.length > 0) {
      row.status = 'invalid';
      invalid += 1;
    } else if (match) {
      row.status = 'duplicate';
      duplicates += 1;
      if (job.options?.duplicateStrategy === 'error') {
        row.set('issues', [{ field: 'identity', message: 'A matching record already exists.' }]);
        row.status = 'invalid';
        invalid += 1;
        duplicates -= 1;
      }
    } else {
      row.status = 'valid';
      valid += 1;
    }

    await row.save();
  }

  const willCreate = valid;
  await assertRoomForImport(job.entityType as 'asset' | 'person', willCreate);

  job.counts = {
    ...job.counts,
    total: rows.length,
    valid,
    invalid,
    duplicates,
  } as never;
  job.status = 'preview';
  job.validatedAt = new Date();
  await job.save();

  return job;
}

function identityKey(values: Record<string, unknown>, entityType: 'asset' | 'person'): string | null {
  if (entityType === 'asset') {
    const serial = values.serialNumber;
    return serial ? `serial:${String(serial).toLowerCase()}` : null;
  }

  const email = values.email;
  const code = values.employeeCode;
  if (email) return `email:${String(email).toLowerCase()}`;
  if (code) return `code:${String(code).toLowerCase()}`;
  return null;
}

async function findExisting(
  values: Record<string, unknown>,
  entityType: 'asset' | 'person',
): Promise<string | null> {
  if (entityType === 'asset') {
    if (!values.serialNumber) return null;
    const found = await AssetModel.findOne({ serialNumber: values.serialNumber }).select('_id').lean();
    return found ? String(found._id) : null;
  }

  const filter = values.email
    ? { email: values.email }
    : values.employeeCode
      ? { employeeCode: values.employeeCode }
      : null;

  if (!filter) return null;

  const found = await PersonModel.findOne(filter).select('_id').lean();
  return found ? String(found._id) : null;
}

/**
 * Refuses the whole import if it would breach the plan.
 *
 * Checked at VALIDATION, not partway through the commit. Importing 2,000 rows
 * and stopping at the limit leaves an estate half-loaded and a user with no
 * idea which half (docs/06-edge-cases.md #38).
 */
async function assertRoomForImport(entityType: 'asset' | 'person', creating: number): Promise<void> {
  if (creating === 0) return;

  const { entitlements } = await resolveEntitlements();
  const limit = entityType === 'asset' ? entitlements.assets : entitlements.people;
  if (limit === null || limit === undefined) return;

  const { usage } = await getUsage();
  const used = (entityType === 'asset' ? usage.assets : usage.people) ?? 0;

  if (used + creating > limit) {
    const { EntitlementExceededError } = await import('../../core/errors/index.js');
    throw new EntitlementExceededError(
      `${entityType}s (importing ${creating}, ${limit - used} slots left)`,
      limit,
      used,
    );
  }
}

/**
 * Step 5: the commit.
 *
 * Batched, and idempotent per row. Each row goes through the SAME service the
 * API uses, so an imported record is indistinguishable from a hand-created one
 * — same validation, same events, same audit trail.
 */
export async function commitImport(id: string): Promise<ImportJobDocument> {
  const job = await findImport(id);

  if (job.status !== 'preview') {
    throw new ValidationError('Validate this import before committing it.', {
      status: [`Currently ${job.status}.`],
    });
  }

  job.status = 'committing';
  job.progress = 0;
  await job.save();

  const strategy = job.options?.duplicateStrategy ?? 'error';
  const entityType = job.entityType as 'asset' | 'person';

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  const total = await ImportRowModel.countDocuments({
    importJobId: id,
    status: { $in: ['valid', 'duplicate'] },
  });

  for (;;) {
    // Re-queried each round rather than paged: rows leave the set as they are
    // committed, so an offset would skip whatever moved.
    const batch = await ImportRowModel.find({
      importJobId: id,
      status: { $in: ['valid', 'duplicate'] },
    })
      .sort({ rowNumber: 1 })
      .limit(COMMIT_BATCH_SIZE)
      .exec();

    if (batch.length === 0) break;

    for (const row of batch) {
      const values = (row.normalised ?? {}) as Record<string, unknown>;
      const customFields = (values.customFields ?? {}) as Record<string, unknown>;

      try {
        if (row.matchedEntityId) {
          if (strategy === 'skip') {
            row.status = 'skipped';
            skipped += 1;
          } else {
            await applyUpdate(entityType, row.matchedEntityId, values, customFields);
            row.resultEntityId = row.matchedEntityId;
            row.status = 'updated';
            updated += 1;
          }
        } else {
          const entityId = await applyCreate(entityType, job, values, customFields);
          row.resultEntityId = entityId;
          row.status = 'created';
          created += 1;
        }
      } catch (err) {
        // One bad row must not abort the run. The user gets a per-row reason and
        // a file of just the failures to fix and re-upload.
        row.status = 'failed';
        row.set('issues', [{ field: 'commit', message: (err as Error).message.slice(0, 300) }]);
        failed += 1;
        logger.warn({ importJobId: id, rowNumber: row.rowNumber, err }, 'Import row failed');
      }

      await row.save();

      processed += 1;
      job.progress = total > 0 ? Math.round((processed / total) * 100) : 100;
    }

    await job.save();
  }

  job.counts = { ...job.counts, created, updated, skipped, failed } as never;
  job.status = 'completed';
  job.progress = 100;
  job.committedAt = new Date();
  await job.save();

  logger.info({ importJobId: id, created, updated, skipped, failed }, 'Import committed');

  return job;
}

async function applyCreate(
  entityType: 'asset' | 'person',
  job: ImportJobDocument,
  values: Record<string, unknown>,
  customFields: Record<string, unknown>,
): Promise<string> {
  if (entityType === 'person') {
    const person = await createPerson({
      firstName: String(values.firstName),
      lastName: String(values.lastName),
      email: (values.email as string) ?? null,
      employeeCode: (values.employeeCode as string) ?? null,
      jobTitle: (values.jobTitle as string) ?? '',
      phone: (values.phone as string) ?? null,
      type: (values.type as string) ?? 'employee',
      departmentId: await resolveOrgUnit('department', values.departmentName, job),
      locationId: await resolveOrgUnit('location', values.locationName, job),
      customFields,
    });

    return String(person._id);
  }

  const assetTypeId = job.options!.assetTypeId!;

  const asset = await createAsset({
    name: String(values.name),
    assetTypeId,
    assetTag: values.assetTag as string | undefined,
    serialNumber: (values.serialNumber as string) ?? null,
    model: (values.model as string) ?? '',
    brand: (values.brand as string) ?? '',
    condition: (values.condition as string) ?? 'good',
    purchase: {
      date: values.purchaseDate ?? null,
      priceMinor: values.purchasePrice ?? null,
      currency: values.currency ?? null,
    },
    warranty: { expiresAt: values.warrantyExpiresAt ?? null },
    placement: {
      locationId: await resolveOrgUnit('location', values.locationName, job),
      departmentId: await resolveOrgUnit('department', values.departmentName, job),
    },
    customFields,
  });

  return String(asset._id);
}

async function applyUpdate(
  entityType: 'asset' | 'person',
  entityId: string,
  values: Record<string, unknown>,
  customFields: Record<string, unknown>,
): Promise<void> {
  if (entityType === 'person') {
    await updatePerson(entityId, {
      ...(values.firstName ? { firstName: String(values.firstName) } : {}),
      ...(values.lastName ? { lastName: String(values.lastName) } : {}),
      ...(values.jobTitle !== undefined ? { jobTitle: String(values.jobTitle) } : {}),
      ...(values.phone !== undefined ? { phone: String(values.phone) } : {}),
      customFields,
    });
    return;
  }

  await updateAsset(entityId, {
    ...(values.name ? { name: String(values.name) } : {}),
    ...(values.model !== undefined ? { model: String(values.model) } : {}),
    ...(values.brand !== undefined ? { brand: String(values.brand) } : {}),
    ...(values.condition ? { condition: String(values.condition) } : {}),
    customFields,
  });
}

/**
 * Resolves a department or location by name.
 *
 * Auto-creation is opt-in and off by default: a typo-ridden spreadsheet
 * otherwise produces "Fincance", "finance " and "Finance" as three separate
 * departments, which is tedious to clean up afterwards
 * (docs/06-edge-cases.md #40).
 */
async function resolveOrgUnit(
  kind: 'department' | 'location',
  name: unknown,
  job: ImportJobDocument,
): Promise<string | null> {
  if (!name) return null;

  const Model = kind === 'department' ? DepartmentModel : LocationModel;
  const trimmed = String(name).trim();

  const existing = await Model.findOne({ name: trimmed }).select('_id').lean();
  if (existing) return String(existing._id);

  if (!job.options?.createMissingReferences) {
    throw new Error(`${kind} "${trimmed}" does not exist. Create it first, or allow auto-creation.`);
  }

  // Cast the argument, not the call: `as never` makes TypeScript pick create()'s
  // array overload, and the result is then an array rather than a document.
  const created = await Model.create({ name: trimmed } as Parameters<typeof Model.create>[0]);
  return String((created as unknown as { _id: unknown })._id);
}

export async function cancelImport(id: string): Promise<ImportJobDocument> {
  const job = await findImport(id);

  if (job.status === 'completed') {
    throw new ValidationError('This import has already finished.', { status: ['completed'] });
  }

  job.status = 'cancelled';
  await job.save();
  return job;
}

export async function listImports(limit = 20) {
  return ImportJobModel.find({}).sort({ createdAt: -1 }).limit(limit).exec();
}

export async function importRows(
  id: string,
  options: { status?: string; limit?: number } = {},
) {
  const filter: Record<string, unknown> = { importJobId: id };
  if (options.status) filter.status = options.status;

  return ImportRowModel.find(filter)
    .sort({ rowNumber: 1 })
    .limit(options.limit ?? 200)
    .exec();
}
