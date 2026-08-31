import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_BUCKETS } from './customFieldValues.js';

/**
 * The custom field registry (ADR-004).
 *
 * One document per field a tenant has defined. It drives four things from a
 * single source: the API validator, the React form renderer, the filter
 * builder, and the import column mapper.
 */
const optionSchema = new Schema(
  {
    /**
     * Stable and generated once. Stored values reference this, never the label,
     * so renaming "In repair" to "At the workshop" breaks nothing.
     */
    id: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    colour: { type: String, default: null },
    archived: { type: Boolean, default: false },
  },
  { _id: false },
);

const customFieldDefinitionSchema = new Schema(
  {
    /**
     * IMMUTABLE. Generated from the label at creation and never changed —
     * it is the storage key for every value ever written. Renaming a field is a
     * label change; this stays put.
     */
    key: { type: String, required: true, immutable: true, trim: true },
    label: { type: String, required: true, trim: true },

    type: { type: String, required: true, enum: CUSTOM_FIELD_TYPES, immutable: true },
    /** Derived from `type`. Denormalised so a query can build its path without a lookup. */
    bucket: { type: String, required: true, enum: CUSTOM_FIELD_BUCKETS, immutable: true },

    /** Which entity the field is attached to. */
    appliesTo: {
      type: String,
      required: true,
      enum: ['asset', 'person', 'vendor', 'licence'],
      immutable: true,
    },
    /** Empty means "every asset type"; otherwise only these. */
    assetTypeIds: { type: [String], default: [] },

    options: { type: [optionSchema], default: [] },

    validation: {
      required: { type: Boolean, default: false },
      min: { type: Number, default: null },
      max: { type: Number, default: null },
      regex: { type: String, default: null },
      maxLength: { type: Number, default: null },
      /** For `reference`: which collection the id must exist in. */
      referenceTo: { type: String, default: null },
      /** For `currency`: ISO code the minor units are denominated in. */
      currency: { type: String, default: null },
    },

    display: {
      section: { type: String, default: 'Details' },
      order: { type: Number, default: 0 },
      helpText: { type: String, default: '' },
      placeholder: { type: String, default: '' },
      showInTable: { type: Boolean, default: false },
    },

    flags: {
      /** Redacted from logs automatically — see core/logging. */
      isPii: { type: Boolean, default: false },
      isSearchable: { type: Boolean, default: false },
      /** Owned by an integration; human edits are reverted on the next sync. */
      isReadOnlyFromIntegration: { type: Boolean, default: false },
    },

    /**
     * Archived fields vanish from forms, tables and filters but KEEP their
     * values on every document. Reversible. Purging is a separate, explicitly
     * confirmed, Owner-only background job (docs/06-edge-cases.md #13).
     */
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

// One key per entity type per tenant. Partial so a purged field's key is reusable.
customFieldDefinitionSchema.index(
  { tenantId: 1, appliesTo: 1, key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// Rendering a form or a filter bar: the fields for an entity, in display order.
customFieldDefinitionSchema.index({
  tenantId: 1,
  appliesTo: 1,
  status: 1,
  'display.order': 1,
});

customFieldDefinitionSchema.index({ tenantId: 1, assetTypeIds: 1 });

export type CustomFieldDefinition = InferSchemaType<typeof customFieldDefinitionSchema>;
export type CustomFieldDefinitionDocument = HydratedDocument<CustomFieldDefinition>;

export const CustomFieldDefinitionModel = defineModel(
  'CustomFieldDefinition',
  customFieldDefinitionSchema,
);
