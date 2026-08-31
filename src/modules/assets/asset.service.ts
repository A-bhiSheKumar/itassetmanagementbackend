import { NotFoundError, ValidationError, StaleWriteError } from '../../core/errors/index.js';
import { withTransaction } from '../../core/db/index.js';
import { emit, flushOutbox, type FieldChange } from '../../core/events/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import {
  compileFieldSchema,
  definitionsFor,
  flattenCustomFields,
  planTransition,
  AssetTypeModel,
} from '../catalog/index.js';
import { AssetModel, buildAssetSearchTokens, type AssetDocument } from './asset.model.js';
import { nextSequence } from './counter.model.js';

/**
 * Generates the next asset tag for a type.
 *
 * Sequence comes from the atomic counter, never from a count or a max — both
 * race under concurrent creation and produce duplicates (see counter.model.ts).
 */
export async function generateAssetTag(prefix: string): Promise<string> {
  const seq = await nextSequence(`assetTag:${prefix}`);
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export interface AssetInput {
  name: string;
  assetTypeId: string;
  assetTag?: string;
  serialNumber?: string | null;
  model?: string;
  brand?: string;
  description?: string;
  condition?: string;
  categoryId?: string | null;
  purchase?: Record<string, unknown>;
  warranty?: Record<string, unknown>;
  placement?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

async function applyCustomFields(
  asset: AssetDocument,
  input: Record<string, unknown> | undefined,
  mode: 'create' | 'update',
): Promise<void> {
  if (mode === 'update' && input === undefined) return;

  const definitions = await definitionsFor({ appliesTo: 'asset', assetTypeId: asset.assetTypeId });

  // Merge on update: parsing only what was sent would silently wipe every
  // field the request did not mention. On create, always run — otherwise a
  // required field is bypassable by omitting the key.
  const merged =
    mode === 'update'
      ? { ...flattenCustomFields(asset.cf as never), ...(input ?? {}) }
      : (input ?? {});

  asset.cf = compileFieldSchema(definitions).parse(merged) as never;
}

export async function createAsset(input: AssetInput): Promise<AssetDocument> {
  await assertWithinLimit('assets');

  const type = await AssetTypeModel.findById(input.assetTypeId).exec();
  if (!type) {
    throw new ValidationError('That asset type does not exist.', {
      assetTypeId: ['Not found.'],
    });
  }

  if (type.requiresSerial && !input.serialNumber) {
    throw new ValidationError(`A ${type.name.toLowerCase()} needs a serial number.`, {
      serialNumber: ['Required for this asset type.'],
    });
  }

  const assetTag = input.assetTag ?? (await generateAssetTag(type.tagPrefix || 'AST'));

  // Constructed INSIDE the transaction: a retry after a rollback must rebuild
  // the document, not re-save one that already believes it was written.
  const asset = await withTransaction(async (session) => {
    const draft = new AssetModel({
      assetTag,
      name: input.name,
      description: input.description ?? '',
      assetTypeId: input.assetTypeId,
      categoryId: input.categoryId ?? type.categoryId ?? null,
      lifecycleState: 'in_stock',
      condition: input.condition ?? 'good',
      // Empty string must become null, or the partial unique index treats "" as
      // a real serial and the second asset without one collides.
      serialNumber: input.serialNumber || null,
      model: input.model ?? '',
      brand: input.brand ?? '',
      purchase: input.purchase ?? {},
      warranty: input.warranty ?? {},
      placement: input.placement ?? {},
    });

    draft.searchTokens = buildAssetSearchTokens(draft);
    await applyCustomFields(draft, input.customFields, 'create');

    await draft.save({ session });

    await emit(
      {
        type: 'asset.created',
        subjectId: String(draft._id),
        subjectType: 'asset',
        summary: `${draft.name} (${draft.assetTag}) was added`,
      },
      session,
    );

    return draft;
  });

  await incrementUsage('assets');
  await flushOutbox();

  return asset;
}

/** Field labels for the timeline. A diff of raw paths reads like a stack trace. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  serialNumber: 'Serial number',
  model: 'Model',
  brand: 'Brand',
  condition: 'Condition',
  description: 'Description',
  categoryId: 'Category',
  'placement.locationId': 'Location',
  'placement.departmentId': 'Department',
  'warranty.expiresAt': 'Warranty expiry',
  'purchase.priceMinor': 'Purchase price',
};

function diff(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const from = before[field];
    const to = after[field];
    if (String(from ?? '') === String(to ?? '')) continue;
    changes.push({ field, label, from: from ?? null, to: to ?? null });
  }

  return changes;
}

function snapshot(asset: AssetDocument): Record<string, unknown> {
  return {
    name: asset.name,
    serialNumber: asset.serialNumber,
    model: asset.model,
    brand: asset.brand,
    condition: asset.condition,
    description: asset.description,
    categoryId: asset.categoryId,
    'placement.locationId': asset.placement?.locationId,
    'placement.departmentId': asset.placement?.departmentId,
    'warranty.expiresAt': asset.warranty?.expiresAt,
    'purchase.priceMinor': asset.purchase?.priceMinor,
  };
}

export async function findAsset(id: string): Promise<AssetDocument> {
  const asset = await AssetModel.findById(id).exec();
  if (!asset) throw new NotFoundError('Asset');
  return asset;
}

export async function updateAsset(
  id: string,
  input: Partial<AssetInput>,
  expectedVersion?: number,
): Promise<AssetDocument> {
  // Loaded and mutated inside the transaction so a retry starts from the
  // database, not from a half-mutated document (see withTransaction's note).
  const asset = await withTransaction(async (session) => {
    const doc = await AssetModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Asset');

    // Optimistic locking: two people editing the same asset must not silently
    // overwrite each other.
    if (expectedVersion !== undefined && doc.__v !== expectedVersion) {
      throw new StaleWriteError();
    }

    const before = snapshot(doc);

    for (const key of ['name', 'model', 'brand', 'description', 'condition', 'categoryId'] as const) {
      if (input[key] !== undefined) (doc as never as Record<string, unknown>)[key] = input[key];
    }

    if (input.serialNumber !== undefined) doc.serialNumber = input.serialNumber || null;
    if (input.purchase) Object.assign(doc.purchase ?? {}, input.purchase);
    if (input.warranty) Object.assign(doc.warranty ?? {}, input.warranty);
    if (input.placement) Object.assign(doc.placement ?? {}, input.placement);

    await applyCustomFields(doc, input.customFields, 'update');
    doc.searchTokens = buildAssetSearchTokens(doc);

    const changes = diff(before, snapshot(doc));

    await doc.save({ session });

    // No event for a no-op edit: a timeline full of "nothing changed" entries
    // is worse than no timeline.
    if (changes.length > 0 || input.customFields) {
      await emit(
        {
          type: 'asset.updated',
          subjectId: String(doc._id),
          subjectType: 'asset',
          summary: `${doc.name} was updated`,
          changes,
        },
        session,
      );
    }

    return doc;
  });

  await flushOutbox();
  return asset;
}

/**
 * Moves an asset to a new lifecycle state.
 *
 * The engine decides whether the move is legal; this applies it. Guards that
 * depend on assignment state are answered from the cached pointer, which the
 * assignment service keeps in step inside its own transactions.
 */
export async function transitionAsset(
  id: string,
  to: string,
  options: { comment?: string; fields?: Record<string, unknown> } = {},
): Promise<AssetDocument> {
  // Validated first — a refused move should not open a transaction at all.
  const current = await findAsset(id);
  const type = await AssetTypeModel.findById(current.assetTypeId).exec();

  const plan = await planTransition({
    workflowId: type?.lifecycleWorkflowId,
    from: current.lifecycleState,
    to,
    context: {
      hasActiveAssignment: current.currentAssignment !== null,
      comment: options.comment,
      fields: options.fields,
    },
  });

  const asset = await withTransaction(async (session) => {
    const doc = await AssetModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Asset');

    const from = doc.lifecycleState;
    doc.lifecycleState = to;
    doc.lifecycleVersion = plan.workflowVersion;

    await doc.save({ session });

    await emit(
      {
        type: 'asset.transitioned',
        subjectId: String(doc._id),
        subjectType: 'asset',
        summary: `${doc.name}: ${plan.label}`,
        changes: [{ field: 'lifecycleState', label: 'State', from, to }],
        comment: options.comment,
      },
      session,
    );

    return doc;
  });

  await flushOutbox();
  return asset;
}

export async function deleteAsset(id: string): Promise<void> {
  const asset = await findAsset(id);

  if (asset.currentAssignment) {
    throw new ValidationError(
      'This asset is still assigned. Return it before deleting it.',
      { assignment: ['Still assigned.'] },
    );
  }

  await withTransaction(async (session) => {
    const doc = await AssetModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Asset');

    doc.deletedAt = new Date();
    await doc.save({ session });

    await emit(
      {
        type: 'asset.deleted',
        subjectId: String(doc._id),
        subjectType: 'asset',
        summary: `${doc.name} (${doc.assetTag}) was deleted`,
      },
      session,
    );
  });

  await incrementUsage('assets', -1);
  await flushOutbox();
}

export async function restoreAsset(id: string): Promise<AssetDocument> {
  const asset = await AssetModel.findById(id).setOptions({ withDeleted: true }).exec();
  if (!asset) throw new NotFoundError('Asset');

  /**
   * Deleting freed this asset's tag AND serial — the partial unique indexes
   * exclude deleted rows — so either may have been claimed since. Checking both
   * turns an opaque duplicate-key 409 into a 422 that names what clashes and
   * why restore is not possible.
   */
  const clashes: Record<string, string[]> = {};

  const tagTaken = await AssetModel.countDocuments({
    assetTag: asset.assetTag,
    _id: { $ne: asset._id },
  });
  if (tagTaken > 0) clashes.assetTag = [`Tag ${asset.assetTag} is now used by another asset.`];

  if (asset.serialNumber) {
    const serialTaken = await AssetModel.countDocuments({
      serialNumber: asset.serialNumber,
      _id: { $ne: asset._id },
    });
    if (serialTaken > 0) {
      clashes.serialNumber = [`Serial ${asset.serialNumber} is now used by another asset.`];
    }
  }

  if (Object.keys(clashes).length > 0) {
    throw new ValidationError(
      'This asset cannot be restored — another asset has taken its identifiers.',
      clashes,
    );
  }

  const restored = await withTransaction(async (session) => {
    const doc = await AssetModel.findById(id)
      .setOptions({ withDeleted: true })
      .session(session)
      .exec();
    if (!doc) throw new NotFoundError('Asset');

    doc.deletedAt = null;
    doc.deletedBy = null;
    await doc.save({ session });

    await emit(
      {
        type: 'asset.restored',
        subjectId: String(doc._id),
        subjectType: 'asset',
        summary: `${doc.name} (${doc.assetTag}) was restored`,
      },
      session,
    );

    return doc;
  });

  await incrementUsage('assets');
  await flushOutbox();
  return restored;
}
