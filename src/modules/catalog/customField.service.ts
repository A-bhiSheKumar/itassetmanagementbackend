import { z } from 'zod';
import { ulid } from 'ulid';
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../../core/errors/index.js';
import {
  BUCKET_FOR_TYPE,
  emptyCustomFieldValues,
  type CustomFieldBucket,
  type CustomFieldType,
  type CustomFieldValues,
} from './customFieldValues.js';
import {
  CustomFieldDefinitionModel,
  type CustomFieldDefinition,
  type CustomFieldDefinitionDocument,
} from './customFieldDefinition.model.js';

/**
 * Turns field definitions into a validator.
 *
 * One compiler, four consumers: the API write path, the React form renderer,
 * the filter builder and the import mapper. Any other arrangement guarantees
 * they eventually disagree about what a valid value is.
 */

const RESERVED_KEYS = new Set([
  'id', '_id', 'tenantId', 'createdAt', 'updatedAt', 'deletedAt', 'cf', 'name', 'status',
]);

/**
 * Derives the storage key from the label, once.
 *
 * After creation this never changes: it is the key under which every value has
 * been written. Renaming a field changes the label only.
 */
export function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export async function generateFieldKey(appliesTo: string, label: string): Promise<string> {
  const base = slugifyFieldKey(label) || 'field';

  if (RESERVED_KEYS.has(base)) {
    throw new ValidationError('That name is reserved. Choose another.', {
      label: ['Reserved name.'],
    });
  }

  const taken = await CustomFieldDefinitionModel.find({ appliesTo, key: new RegExp(`^${base}(_\\d+)?$`) })
    .select('key')
    .lean();

  if (!taken.some((f) => f.key === base)) return base;

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.some((f) => f.key === candidate)) return candidate;
  }

  return `${base}_${ulid().slice(-6).toLowerCase()}`;
}

export function bucketForType(type: CustomFieldType): CustomFieldBucket {
  return BUCKET_FOR_TYPE[type];
}

/** Definitions that apply to a given asset type (or to all of them). */
export async function definitionsFor(input: {
  appliesTo: string;
  assetTypeId?: string | null;
  includeArchived?: boolean;
}): Promise<CustomFieldDefinitionDocument[]> {
  const query: Record<string, unknown> = { appliesTo: input.appliesTo };
  if (!input.includeArchived) query.status = 'active';

  const all = await CustomFieldDefinitionModel.find(query)
    .sort({ 'display.order': 1, label: 1 })
    .exec();

  if (input.appliesTo !== 'asset' || !input.assetTypeId) return all;

  // An empty assetTypeIds means "applies to every asset type".
  return all.filter(
    (def) => def.assetTypeIds.length === 0 || def.assetTypeIds.includes(input.assetTypeId!),
  );
}

function liveOptionIds(def: CustomFieldDefinition): string[] {
  return def.options.filter((o) => !o.archived).map((o) => o.id);
}

function schemaForField(def: CustomFieldDefinition): z.ZodTypeAny {
  const v = def.validation;

  switch (def.type as CustomFieldType) {
    case 'text':
    case 'textarea': {
      let s = z.string().trim();
      if (v?.maxLength) s = s.max(v.maxLength, `Keep this under ${v.maxLength} characters.`);
      if (v?.regex) {
        try {
          s = s.regex(new RegExp(v.regex), 'That format is not accepted.');
        } catch {
          // A malformed stored pattern must not break every write on the entity.
          // The field is validated on save, so this is belt and braces.
        }
      }
      return s;
    }

    case 'url':
      return z.string().trim().url('Enter a valid URL.');

    case 'email':
      return z.string().trim().toLowerCase().email('Enter a valid email address.');

    // Values reference option IDS, not labels — that is what makes renaming an
    // option free (docs/06-edge-cases.md #16). It also means a client sending
    // the visible label gets a clear rejection rather than a stored string that
    // matches nothing.
    case 'select': {
      const ids = liveOptionIds(def);
      // z.enum() throws at CONSTRUCTION on an empty list, which would turn a
      // fully-archived field into a 500 on every write to the entity.
      if (ids.length === 0) return z.never();
      return z.enum(ids as [string, ...string[]]);
    }

    case 'multiselect': {
      const ids = liveOptionIds(def);
      if (ids.length === 0) return z.array(z.never()).max(0);
      return z.array(z.enum(ids as [string, ...string[]])).max(50);
    }

    case 'number':
    case 'currency': {
      let n = def.type === 'currency' ? z.number().int('Amounts are whole minor units.') : z.number();
      if (v?.min !== null && v?.min !== undefined) n = n.min(v.min, `Must be at least ${v.min}.`);
      if (v?.max !== null && v?.max !== undefined) n = n.max(v.max, `Must be at most ${v.max}.`);
      return n;
    }

    case 'date':
      return z.coerce.date();

    case 'boolean':
      return z.boolean();

    case 'reference':
      return z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid reference.');

    default:
      return z.unknown();
  }
}

export interface CompiledFieldSchema {
  /** Parses a flat `{ key: value }` payload into bucketed storage. */
  parse(input: Record<string, unknown>): CustomFieldValues;
  definitions: CustomFieldDefinitionDocument[];
}

/**
 * Compiles definitions into a parser.
 *
 * Accepts the flat shape clients send (`{ ram_gb: 36 }`) and returns bucketed
 * storage (`{ n: { ram_gb: 36 } }`). Unknown keys are REJECTED rather than
 * dropped, so a typo surfaces as an error instead of a value that silently
 * never appears.
 */
export function compileFieldSchema(
  definitions: CustomFieldDefinitionDocument[],
): CompiledFieldSchema {
  const byKey = new Map(definitions.map((d) => [d.key, d]));

  return {
    definitions,

    parse(input: Record<string, unknown>): CustomFieldValues {
      const values = emptyCustomFieldValues();
      const fieldErrors: Record<string, string[]> = {};

      for (const key of Object.keys(input)) {
        if (!byKey.has(key)) {
          fieldErrors[`customFields.${key}`] = ['That field does not exist.'];
        }
      }

      for (const def of definitions) {
        const raw = input[def.key];
        const provided = raw !== undefined && raw !== null && raw !== '';

        if (!provided) {
          if (def.validation?.required) {
            fieldErrors[`customFields.${def.key}`] = [`${def.label} is required.`];
          }
          continue;
        }

        const result = schemaForField(def).safeParse(raw);

        if (!result.success) {
          const isChoice = def.type === 'select' || def.type === 'multiselect';
          fieldErrors[`customFields.${def.key}`] = isChoice
            ? // Zod's default enum message lists raw option ids, which are ULIDs
              // and mean nothing to a human.
              [`Choose one of: ${def.options.filter((o) => !o.archived).map((o) => o.label).join(', ')}.`]
            : result.error.issues.map((i) => i.message);
          continue;
        }

        const bucket = def.bucket as CustomFieldBucket;
        // Indexed write into the matching bucket — see customFieldValues.ts.
        (values[bucket] as Record<string, unknown>)[def.key] = result.data;
      }

      if (Object.keys(fieldErrors).length > 0) {
        throw new ValidationError('Some custom fields are not valid.', fieldErrors);
      }

      return values;
    },
  };
}

export async function createDefinition(input: {
  appliesTo: string;
  label: string;
  type: CustomFieldType;
  assetTypeIds?: string[];
  options?: Array<{ label: string; colour?: string }>;
  validation?: Record<string, unknown>;
  display?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}): Promise<CustomFieldDefinitionDocument> {
  const needsOptions = input.type === 'select' || input.type === 'multiselect';

  if (needsOptions && (input.options?.length ?? 0) === 0) {
    throw new ValidationError('A choice field needs at least one option.', {
      options: ['Add at least one option.'],
    });
  }

  return CustomFieldDefinitionModel.create({
    key: await generateFieldKey(input.appliesTo, input.label),
    label: input.label,
    type: input.type,
    bucket: bucketForType(input.type),
    appliesTo: input.appliesTo,
    assetTypeIds: input.assetTypeIds ?? [],
    // Option ids are generated here, once, and never regenerated.
    options: (input.options ?? []).map((o) => ({ id: ulid(), label: o.label, colour: o.colour ?? null })),
    validation: input.validation ?? {},
    display: {
      // Default to the end of the form. Without this every field defaults to
      // order 0 and they render alphabetically — which is never the order
      // someone added them in, and never the order they want them read in.
      order: await nextDisplayOrder(input.appliesTo),
      ...(input.display ?? {}),
    },
    flags: input.flags ?? {},
  });
}

async function nextDisplayOrder(appliesTo: string): Promise<number> {
  const last = await CustomFieldDefinitionModel.findOne({ appliesTo })
    .sort({ 'display.order': -1 })
    .select('display.order')
    .lean<{ display?: { order?: number } } | null>();

  return (last?.display?.order ?? -1) + 1;
}

/**
 * Updates a definition.
 *
 * `key`, `type`, `bucket` and `appliesTo` are immutable in the schema, so this
 * cannot change where values live or how they are interpreted. Changing a
 * field's type means archiving it and creating a new one — silent coercion
 * loses data irrecoverably (docs/06-edge-cases.md #15).
 */
export async function updateDefinition(
  id: string,
  patch: Record<string, unknown>,
): Promise<CustomFieldDefinitionDocument> {
  const def = await CustomFieldDefinitionModel.findById(id);
  if (!def) throw new NotFoundError('Field');

  if (patch.type !== undefined && patch.type !== def.type) {
    throw new AppError(
      422,
      ErrorCode.VALIDATION_FAILED,
      "A field's type cannot be changed. Archive it and create a new one — converting " +
        'existing values silently would lose data.',
      { fields: { type: ['Cannot be changed.'] } },
    );
  }

  if (typeof patch.label === 'string') def.label = patch.label;
  if (Array.isArray(patch.assetTypeIds)) def.assetTypeIds = patch.assetTypeIds as string[];
  if (patch.validation) Object.assign(def.validation ?? {}, patch.validation);
  if (patch.display) Object.assign(def.display ?? {}, patch.display);
  if (patch.flags) Object.assign(def.flags ?? {}, patch.flags);

  // Existing options keep their ids; only new ones are minted. That is what
  // makes renaming or reordering options free for already-stored values.
  if (Array.isArray(patch.options)) {
    const options = (
      patch.options as Array<{ id?: string; label: string; colour?: string; archived?: boolean }>
    ).map((o) => ({
      id: o.id ?? ulid(),
      label: o.label,
      colour: o.colour ?? null,
      archived: o.archived ?? false,
    }));

    // set() rather than assignment: mongoose types the path as a DocumentArray,
    // and going through set() lets it build the subdocuments properly.
    def.set('options', options);
  }

  await def.save();
  return def;
}

export async function setDefinitionStatus(
  id: string,
  status: 'active' | 'archived',
): Promise<CustomFieldDefinitionDocument> {
  const def = await CustomFieldDefinitionModel.findById(id);
  if (!def) throw new NotFoundError('Field');

  def.status = status;
  await def.save();
  return def;
}
