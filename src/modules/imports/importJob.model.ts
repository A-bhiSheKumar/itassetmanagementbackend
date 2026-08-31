import { Schema, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

export const IMPORT_STATUSES = [
  'uploaded',
  'mapping',
  'validating',
  'preview',
  'committing',
  'completed',
  'failed',
  'cancelled',
] as const;

/**
 * How to treat a row that matches an existing record.
 *
 * An explicit choice rather than a guess: silently skipping loses data the user
 * meant to add, and silently updating overwrites data they meant to keep.
 */
export const DUPLICATE_STRATEGIES = ['skip', 'update', 'error'] as const;

const importJobSchema = new Schema(
  {
    entityType: { type: String, required: true, enum: ['asset', 'person'] },

    fileName: { type: String, required: true },
    storageKey: { type: String, default: null },
    fileFormat: { type: String, enum: ['csv', 'xlsx'], required: true },

    status: { type: String, enum: IMPORT_STATUSES, default: 'uploaded' },

    /** `{ 'Serial Number': 'serialNumber' }` — header to field. */
    columnMapping: { type: Schema.Types.Mixed, default: {} },
    /** Headers found in the file, in order, for the mapping UI. */
    detectedHeaders: { type: [String], default: [] },

    options: {
      duplicateStrategy: { type: String, enum: DUPLICATE_STRATEGIES, default: 'error' },
      /** Which date order to read — never guessed (docs/06-edge-cases.md #47). */
      dateFormat: { type: String, enum: ['DMY', 'MDY', 'ISO'], default: 'DMY' },
      assetTypeId: { type: String, default: null },
      /** Reject the row, or create the missing category/location. */
      createMissingReferences: { type: Boolean, default: false },
    },

    counts: {
      total: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },

    /** Progress for the UI while a large commit runs. */
    progress: { type: Number, default: 0 },

    startedBy: { type: String, default: null },
    validatedAt: { type: Date, default: null },
    committedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

importJobSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
importJobSchema.index({ tenantId: 1, createdAt: -1 });

export type ImportJob = Scoped<InferSchemaType<typeof importJobSchema>>;
export type ImportJobDocument = HydratedDocument<ImportJob>;

export const ImportJobModel = defineModel(
  'ImportJob',
  importJobSchema,
) as unknown as Model<ImportJob>;
