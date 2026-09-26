import { NotFoundError, ResourceInUseError, ValidationError } from '../../core/errors/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import { AssetCategoryModel, type AssetCategoryDocument } from './assetCategory.model.js';
import { AssetTypeModel, type AssetTypeDocument } from './assetType.model.js';
import { CustomFieldDefinitionModel } from './customFieldDefinition.model.js';
import { seedDefaultWorkflow } from './lifecycle.service.js';
import { createDefinition, setDefinitionStatus } from './customField.service.js';
import { slugifyFieldKey } from './customField.service.js';
import type { CustomFieldType } from './customFieldValues.js';
import { DEFAULT_INDUSTRY, findPreset } from './industry.js';

/**
 * Starter catalogue, seeded on tenant creation from the chosen industry preset.
 *
 * A new organisation that opens to an empty screen has to invent a taxonomy
 * before it can add anything, so it starts with the categories, types and
 * fields its industry almost always has — and can rename or archive every one
 * of them. Presets live in industry.ts; nothing here is specific to IT.
 */
export async function seedCatalog(industry: string = DEFAULT_INDUSTRY): Promise<void> {
  const existing = await AssetTypeModel.countDocuments({});
  if (existing > 0) return;

  // The workflow is seeded even for the blank preset: an asset with no
  // lifecycle cannot be created at all.
  await seedDefaultWorkflow();
  await applyPreset(industry);
}

/**
 * Adds a preset's categories, types and fields, skipping anything already
 * there by name.
 *
 * Idempotent, so it is safe to offer as "add the starter setup for my
 * industry" long after signup — an organisation that started blank, or that
 * has grown into a second kind of estate, gets the additions without losing or
 * duplicating what it already has.
 */
export async function applyPreset(industry: string): Promise<{
  preset: string;
  categories: number;
  types: number;
  fields: number;
}> {
  const preset = findPreset(industry);
  const workflow = await seedDefaultWorkflow();

  const existingCategories = await AssetCategoryModel.find({}).select('name').lean();
  const categoryByName = new Map(existingCategories.map((c) => [c.name.toLowerCase(), String(c._id)]));

  let categories = 0;
  for (const category of preset.categories) {
    if (categoryByName.has(category.name.toLowerCase())) continue;
    const created = await AssetCategoryModel.create({ name: category.name, icon: category.icon ?? null });
    categoryByName.set(category.name.toLowerCase(), String(created._id));
    categories += 1;
  }

  const existingTypes = await AssetTypeModel.find({}).select('name').lean();
  const typeByName = new Map(existingTypes.map((t) => [t.name.toLowerCase(), String(t._id)]));

  let types = 0;
  for (const type of preset.types) {
    if (typeByName.has(type.name.toLowerCase())) continue;
    const created = await AssetTypeModel.create({
      key: slugifyFieldKey(type.name),
      name: type.name,
      categoryId: categoryByName.get(type.category.toLowerCase()) ?? null,
      lifecycleWorkflowId: String(workflow._id),
      tagPrefix: type.tagPrefix,
      requiresSerial: type.requiresSerial,
    });
    typeByName.set(type.name.toLowerCase(), String(created._id));
    types += 1;
  }

  const existingFields = await CustomFieldDefinitionModel.find({}).select('label appliesTo').lean();
  const hasField = new Set(existingFields.map((f) => `${f.appliesTo}:${f.label.toLowerCase()}`));

  let fields = 0;
  for (const field of preset.fields) {
    if (hasField.has(`${field.appliesTo}:${field.label.toLowerCase()}`)) continue;
    await createDefinition({
      appliesTo: field.appliesTo,
      label: field.label,
      type: field.type,
      // Named types, resolved to ids here: a preset cannot know them.
      assetTypeIds: (field.forTypes ?? [])
        .map((name) => typeByName.get(name.toLowerCase()))
        .filter((id): id is string => Boolean(id)),
      options: (field.options ?? []).map((label) => ({ label })),
      display: { showInTable: field.showInTable ?? false },
      ...(field.required ? { validation: { required: true } } : {}),
    });
    fields += 1;
  }

  return { preset: preset.key, categories, types, fields };
}

export function listAssetTypes(): Promise<AssetTypeDocument[]> {
  return AssetTypeModel.find({}).sort({ status: 1, name: 1 }).exec();
}

export function listCategories(): Promise<AssetCategoryDocument[]> {
  return AssetCategoryModel.find({}).sort({ name: 1 }).exec();
}

export async function createAssetType(input: {
  name: string;
  categoryId?: string | null;
  tagPrefix?: string | null;
  isSerialised?: boolean;
  requiresSerial?: boolean;
  icon?: string | null;
}): Promise<AssetTypeDocument> {
  const key = slugifyFieldKey(input.name);
  if (!key) throw new ValidationError('Give this type a name.', { name: ['Required.'] });

  const workflow = await seedDefaultWorkflow();

  return AssetTypeModel.create({
    key,
    name: input.name,
    categoryId: input.categoryId ?? null,
    lifecycleWorkflowId: String(workflow._id),
    tagPrefix: input.tagPrefix ?? null,
    isSerialised: input.isSerialised ?? true,
    requiresSerial: input.requiresSerial ?? false,
    icon: input.icon ?? null,
  });
}

/**
 * Archiving an asset type rather than deleting it.
 *
 * Deletion is refused while assets reference it — the assets would render with
 * a dangling type and their custom field definitions would stop resolving
 * (docs/06-edge-cases.md #14). Archiving removes it from creation menus while
 * every existing asset keeps working.
 */
export async function archiveAssetType(id: string): Promise<AssetTypeDocument> {
  const type = await AssetTypeModel.findById(id);
  if (!type) throw new NotFoundError('Asset type');

  type.status = 'archived';
  await type.save();
  return type;
}

export async function deleteAssetType(id: string): Promise<void> {
  const type = await AssetTypeModel.findById(id);
  if (!type) throw new NotFoundError('Asset type');

  const fieldCount = await CustomFieldDefinitionModel.countDocuments({ assetTypeIds: id });

  if (fieldCount > 0) {
    throw new ResourceInUseError('asset type', [{ type: 'custom field', count: fieldCount }]);
  }

  // Asset reference counting lands with the asset module in M3. Archiving is
  // the safe operation until then, and is what the UI offers.
  await type.softDelete();
}

/** Creates a custom field, checking the plan limit first. */
export async function addCustomField(input: {
  appliesTo: string;
  label: string;
  type: CustomFieldType;
  assetTypeIds?: string[];
  options?: Array<{ label: string; colour?: string }>;
  validation?: Record<string, unknown>;
  display?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}) {
  await assertWithinLimit('customFields');
  const definition = await createDefinition(input);
  await incrementUsage('customFields');
  return definition;
}

export async function archiveCustomField(id: string) {
  const definition = await setDefinitionStatus(id, 'archived');
  // Archived fields no longer count against the plan — they are invisible to
  // the user, so billing for them would be indefensible.
  await incrementUsage('customFields', -1);
  return definition;
}

export async function restoreCustomField(id: string) {
  await assertWithinLimit('customFields');
  const definition = await setDefinitionStatus(id, 'active');
  await incrementUsage('customFields');
  return definition;
}
