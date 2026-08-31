import { Schema, type InferSchemaType, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * One staged row.
 *
 * Rows are parsed and validated into this collection BEFORE anything is written
 * to the real one. That is what makes the preview a genuine dry run rather than
 * an optimistic guess, and it is what lets a user fix twelve rows and re-run
 * instead of starting over.
 */
const importRowSchema = new Schema(
  {
    importJobId: { type: String, required: true },
    /** 1-based, matching what the user sees in their spreadsheet. */
    rowNumber: { type: Number, required: true },

    /** Exactly what was in the file, for the error report. */
    raw: { type: Schema.Types.Mixed, default: {} },
    /** Parsed and coerced, ready to write. */
    normalised: { type: Schema.Types.Mixed, default: {} },

    /**
     * Named `issues`, not `errors`.
     *
     * `errors` is a RESERVED mongoose path — it is where mongoose puts
     * ValidationError entries — so a validation failure on this document would
     * silently overwrite the row's recorded problems. Mongoose warns about it;
     * the warning is right. The API still calls the field `errors`, which is
     * what a client expects.
     */
    issues: {
      type: [{ field: String, message: String, _id: false }],
      default: [],
    },

    status: {
      type: String,
      enum: ['valid', 'invalid', 'duplicate', 'created', 'updated', 'skipped', 'failed'],
      default: 'valid',
    },

    /** The record this row produced, once committed. */
    resultEntityId: { type: String, default: null },
    /** An existing record this row matches, for update/skip. */
    matchedEntityId: { type: String, default: null },

    /**
     * Hash of the row's identifying content.
     *
     * Unique per job, so a retried or resumed commit cannot create the same row
     * twice. Without it, a commit interrupted at row 3,000 would duplicate
     * everything before it on the retry.
     */
    rowHash: { type: String, required: true },
  },
  { timestamps: true },
);

importRowSchema.index({ importJobId: 1, rowNumber: 1 });
importRowSchema.index({ importJobId: 1, status: 1 });

// Commit idempotency — the reason a retry is safe.
importRowSchema.index({ tenantId: 1, importJobId: 1, rowHash: 1 }, { unique: true });

// Staging data is disposable once the job is done and reviewed.
importRowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

export type ImportRow = Scoped<InferSchemaType<typeof importRowSchema>>;

export const ImportRowModel = defineModel(
  'ImportRow',
  importRowSchema,
) as unknown as Model<ImportRow>;
