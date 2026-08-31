import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import {
  listAssetTypes,
  listCategories,
  createAssetType,
  archiveAssetType,
  addCustomField,
  archiveCustomField,
  restoreCustomField,
} from './catalog.service.js';
import { AssetCategoryModel } from './assetCategory.model.js';
import { AssetTypeModel } from './assetType.model.js';
import { CustomFieldDefinitionModel, type CustomFieldDefinitionDocument } from './customFieldDefinition.model.js';
import { definitionsFor, updateDefinition } from './customField.service.js';
import { getWorkflow, availableTransitions } from './lifecycle.service.js';

/**
 * DTO mappers.
 *
 * Models are never serialised directly — that is how internal flags and
 * `passwordHash`-shaped fields leak. Every response is an explicit allowlist.
 */
function presentField(def: CustomFieldDefinitionDocument) {
  return {
    id: String(def._id),
    key: def.key,
    label: def.label,
    type: def.type,
    bucket: def.bucket,
    appliesTo: def.appliesTo,
    assetTypeIds: def.assetTypeIds,
    options: def.options.map((o) => ({
      id: o.id,
      label: o.label,
      colour: o.colour,
      archived: o.archived,
    })),
    validation: def.validation,
    display: def.display,
    flags: def.flags,
    status: def.status,
  };
}

export async function types(_req: Request, res: Response): Promise<void> {
  const all = await listAssetTypes();
  ok(
    res,
    all.map((t) => ({
      id: String(t._id),
      key: t.key,
      name: t.name,
      icon: t.icon,
      categoryId: t.categoryId,
      lifecycleWorkflowId: t.lifecycleWorkflowId,
      isSerialised: t.isSerialised,
      requiresSerial: t.requiresSerial,
      tagPrefix: t.tagPrefix,
      status: t.status,
    })),
  );
}

export async function createType(req: Request, res: Response): Promise<void> {
  const type = await createAssetType(req.body as { name: string });
  created(res, { id: String(type._id), key: type.key, name: type.name });
}

export async function archiveType(req: Request, res: Response): Promise<void> {
  await archiveAssetType(req.params.id!);
  noContent(res);
}

export async function categories(_req: Request, res: Response): Promise<void> {
  const all = await listCategories();
  ok(
    res,
    all.map((c) => ({
      id: String(c._id),
      name: c.name,
      parentId: c.parentId,
      path: c.path,
      icon: c.icon,
      colour: c.colour,
      status: c.status,
    })),
  );
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const category = await AssetCategoryModel.create(req.body as { name: string });
  created(res, { id: String(category._id), name: category.name });
}

/**
 * The fields for an entity — and, for assets, for a specific type.
 *
 * This single endpoint drives the create form, the edit form, the filter
 * builder and the table column picker on the client. One source of truth.
 */
export async function fields(req: Request, res: Response): Promise<void> {
  const query = req.query as { appliesTo?: string; assetTypeId?: string; includeArchived?: string };

  const definitions = await definitionsFor({
    appliesTo: query.appliesTo ?? 'asset',
    assetTypeId: query.assetTypeId ?? null,
    includeArchived: query.includeArchived === 'true',
  });

  ok(res, definitions.map(presentField));
}

export async function createField(req: Request, res: Response): Promise<void> {
  const definition = await addCustomField(req.body as never);
  created(res, presentField(definition));
}

export async function updateField(req: Request, res: Response): Promise<void> {
  const definition = await updateDefinition(req.params.id!, req.body as Record<string, unknown>);
  ok(res, presentField(definition));
}

export async function archiveField(req: Request, res: Response): Promise<void> {
  const definition = await archiveCustomField(req.params.id!);
  ok(res, presentField(definition));
}

export async function restoreField(req: Request, res: Response): Promise<void> {
  const definition = await restoreCustomField(req.params.id!);
  ok(res, presentField(definition));
}

export async function showField(req: Request, res: Response): Promise<void> {
  const definition = await CustomFieldDefinitionModel.findById(req.params.id!).exec();
  if (!definition) throw new NotFoundError('Field');
  ok(res, presentField(definition));
}

export async function workflows(_req: Request, res: Response): Promise<void> {
  const workflow = await getWorkflow();
  ok(res, {
    id: String(workflow._id),
    name: workflow.name,
    isDefault: workflow.isDefault,
    initialState: workflow.initialState,
    version: workflow.version,
    states: workflow.states,
    transitions: workflow.transitions,
  });
}

/**
 * The moves available from a state, for THIS actor.
 *
 * Computed server-side and filtered by permission, so the buttons a user sees
 * and the moves the engine will accept cannot drift apart.
 */
export async function transitionsFrom(req: Request, res: Response): Promise<void> {
  const { from } = req.params as { from: string };
  const type = req.query.assetTypeId
    ? await AssetTypeModel.findById(String(req.query.assetTypeId)).exec()
    : null;

  ok(res, await availableTransitions({ workflowId: type?.lifecycleWorkflowId, from }));
}
