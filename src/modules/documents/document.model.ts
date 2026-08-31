import { Schema, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

const documentSchema = new Schema(
  {
    entityType: { type: String, required: true, enum: ['asset', 'person', 'vendor', 'licence', 'maintenance'] },
    entityId: { type: String, required: true },

    category: {
      type: String,
      enum: ['invoice', 'warranty', 'contract', 'photo', 'receipt', 'report', 'other'],
      default: 'other',
    },

    fileName: { type: String, required: true },
    /** VERIFIED from the file's own bytes, never the client's claim. */
    contentType: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },

    storageKey: { type: String, required: true },
    checksum: { type: String, default: null },

    /**
     * `pending` until the upload is confirmed and its bytes verified. A sweeper
     * removes stale pending rows and their orphaned objects — otherwise an
     * abandoned upload leaves a row promising a file that was never stored.
     */
    status: {
      type: String,
      enum: ['pending', 'ready', 'infected', 'rejected'],
      default: 'pending',
    },
    rejectionReason: { type: String, default: null },
    scanResult: { type: String, default: null },

    uploadedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// Attachments on a record — the query the asset detail page makes.
documentSchema.index({ tenantId: 1, entityType: 1, entityId: 1, createdAt: -1 });

// Storage keys are globally unique by construction (16 random bytes), but the
// index is prefixed like every other so the rule stays absolute.
documentSchema.index({ tenantId: 1, storageKey: 1 }, { unique: true });

// The sweeper's query: abandoned uploads.
documentSchema.index(
  { status: 1, createdAt: 1 },
  { partialFilterExpression: { status: 'pending' } },
);

// Storage accounting.
documentSchema.index({ tenantId: 1, createdAt: -1 });

export type DocumentRecord = Scoped<InferSchemaType<typeof documentSchema>>;
export type DocumentRecordDocument = HydratedDocument<DocumentRecord>;

export const DocumentModel = defineModel(
  'Document',
  documentSchema,
) as unknown as Model<DocumentRecord>;
