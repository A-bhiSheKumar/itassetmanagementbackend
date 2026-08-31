import { NotFoundError, ResourceInUseError, ValidationError } from '../../core/errors/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import { AssetCategoryModel, type AssetCategoryDocument } from './assetCategory.model.js';
import { AssetTypeModel, type AssetTypeDocument } from './assetType.model.js';
import { CustomFieldDefinitionModel } from './customFieldDefinition.model.js';
import { seedDefaultWorkflow } from './lifecycle.service.js';
import { createDefinition, setDefinitionStatus } from './customField.service.js';
import { slugifyFieldKey } from './customField.service.js';
import type { CustomFieldType } from './customFieldValues.js';

/**
 * Starter catalogue, seeded on tenant creation.
 *
 * A new organisation that opens to an empty screen has to invent a taxonomy
 * before it can add anything. These are the categories and types almost every
 * IT estate has; anything unusual they add themselves.
 */
const STARTER_CATEGORIES = [
  { name: 'Computers', icon: 'laptop' },
  { name: 'Displays', icon: 'monitor' },
  { name: 'Mobile devices', icon: 'phone' },
  { name: 'Networking', icon: 'router' },
  { name: 'Peripherals', icon: 'keyboard' },
  { name: 'Software', icon: 'app' },
] as const;

const STARTER_TYPES = [
  { key: 'laptop', name: 'Laptop', category: 'Computers', tagPrefix: 'LAP', requiresSerial: true },
  { key: 'desktop', name: 'Desktop', category: 'Computers', tagPrefix: 'DSK', requiresSerial: true },
  { key: 'monitor', name: 'Monitor', category: 'Displays', tagPrefix: 'MON', requiresSerial: false },
  { key: 'phone', name: 'Mobile phone', category: 'Mobile devices', tagPrefix: 'MOB', requiresSerial: true },
  { key: 'accessory', name: 'Accessory', category: 'Peripherals', tagPrefix: 'ACC', requiresSerial: false },
] as const;

export async function seedCatalog(): Promise<void> {
  const existing = await AssetTypeModel.countDocuments({});
  if (existing > 0) return;

  const workflow = await seedDefaultWorkflow();

  const categories = await AssetCategoryModel.insertMany(
    STARTER_CATEGORIES.map((c) => ({ name: c.name, icon: c.icon })),
  );
  const categoryByName = new Map(categories.map((c) => [c.name, String(c._id)]));

  await AssetTypeModel.insertMany(
    STARTER_TYPES.map((t) => ({
      key: t.key,
      name: t.name,
      categoryId: categoryByName.get(t.category) ?? null,
      lifecycleWorkflowId: String(workflow._id),
      tagPrefix: t.tagPrefix,
      requiresSerial: t.requiresSerial,
    })),
  );
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
