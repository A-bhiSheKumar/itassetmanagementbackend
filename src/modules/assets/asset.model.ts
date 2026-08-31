import { Schema, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';
import { customFieldsPath } from '../catalog/index.js';

/**
 * The asset aggregate.
 *
 * ── Three orthogonal state axes (ADR-006) ─────────────────────────────────
 * `lifecycleState`      where it is in its life — procured → disposed
 * `currentAssignment`   DERIVED. A cached pointer to the active Assignment.
 * `condition`           its physical state
 *
 * They are separate because they are independent. Merging them produces states
 * nobody can answer ("assigned AND damaged?") and forces lossy status changes.
 *
 * `currentAssignment` is written ONLY by the assignment service, inside the
 * same transaction as the Assignment record. Nothing else may touch it, and a
 * reconciliation job asserts the two agree.
 */
const assetSchema = new Schema(
  {
    assetTag: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    assetTypeId: { type: String, required: true },
    categoryId: { type: String, default: null },

    lifecycleState: { type: String, required: true, default: 'in_stock' },
    /** The workflow version this asset was last moved under (ADR-006). */
    lifecycleVersion: { type: Number, default: 1 },

    condition: {
      type: String,
      enum: ['new', 'good', 'fair', 'poor', 'damaged', 'unknown'],
      default: 'good',
    },

    serialNumber: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: '' },
    brand: { type: String, trim: true, default: '' },

    purchase: {
      date: { type: Date, default: null },
      priceMinor: { type: Number, default: null },
      currency: { type: String, default: null },
      vendorId: { type: String, default: null },
      orderRef: { type: String, default: '' },
    },

    warranty: {
      provider: { type: String, default: '' },
      startsAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },

    placement: {
      locationId: { type: String, default: null },
      departmentId: { type: String, default: null },
      subLocation: { type: String, default: '' },
    },

    /**
     * Denormalised cache of the active assignment. Written only by the
     * assignment service; never edited directly.
     */
    currentAssignment: {
      type: {
        assignmentId: String,
        assigneeType: { type: String, enum: ['person', 'location', 'asset'] },
        assigneeId: String,
        assignedAt: Date,
        _id: false,
      },
      default: null,
    },

    /** Kits and components: a dock attached to a laptop. */
    parentAssetId: { type: String, default: null },

    searchTokens: { type: [String], default: [] },

    cf: customFieldsPath(),
  },
  { timestamps: true, optimisticConcurrency: true },
);

// ── Indexes (docs/03-data-model.md §3.4) ──────────────────────────────────

// The default list view, and the most-hit query in the product. ESR: equality
// on tenant/deleted/state, then the sort key.
assetSchema.index({ tenantId: 1, deletedAt: 1, lifecycleState: 1, updatedAt: -1 });

// Tags are unique per tenant. Partial so a deleted asset's tag is reusable.
assetSchema.index(
  { tenantId: 1, assetTag: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

// Serials are unique WHEN PRESENT. Not an optimisation — a plain unique index
// would allow exactly one asset without a serial per tenant, and cables,
// adapters and furniture legitimately have none.
assetSchema.index(
  { tenantId: 1, serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { serialNumber: { $type: 'string' }, deletedAt: null },
  },
);

// The three dimensions every dashboard tile and scoped query uses.
assetSchema.index({ tenantId: 1, assetTypeId: 1, lifecycleState: 1, updatedAt: -1 });
assetSchema.index({ tenantId: 1, categoryId: 1, lifecycleState: 1 });
assetSchema.index({ tenantId: 1, 'placement.locationId': 1, lifecycleState: 1 });
assetSchema.index({ tenantId: 1, 'placement.departmentId': 1, lifecycleState: 1 });

// "What does this person hold?" — the offboarding screen and an employee's
// own view. Sparse: unassigned assets skip the index entirely.
assetSchema.index({ tenantId: 1, 'currentAssignment.assigneeId': 1 }, { sparse: true });

// Warranty pipeline and the nightly expiry scan. The partial filter keeps
// years of disposed assets out of an index queried for every tenant, nightly.
assetSchema.index(
  { tenantId: 1, 'warranty.expiresAt': 1 },
  {
    partialFilterExpression: {
      'warranty.expiresAt': { $type: 'date' },
      lifecycleState: { $nin: ['disposed', 'lost'] },
    },
  },
);

assetSchema.index({ tenantId: 1, searchTokens: 1 });

// Cursor pagination. _id breaks ties so the cursor is stable under writes.
assetSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });

assetSchema.index({ tenantId: 1, parentAssetId: 1 }, { sparse: true });

/**
 * Filter and sort on ANY custom field without knowing its name at schema time.
 *
 * Compound wildcard indexes need MongoDB 7.0+. This is the index that makes
 * `filter[cf.n.ram_gb][gte]=16` an index scan rather than a collection scan.
 */
assetSchema.index({ tenantId: 1, 'cf.$**': 1 });

export type Asset = Scoped<InferSchemaType<typeof assetSchema>>;
export type AssetDocument = HydratedDocument<Asset>;

export const AssetModel = defineModel('Asset', assetSchema) as unknown as Model<Asset>;

/** Tokens for quick search: name, tag, serial, model, brand. */
export function buildAssetSearchTokens(asset: {
  name: string;
  assetTag: string;
  serialNumber?: string | null;
  model?: string;
  brand?: string;
}): string[] {
  const parts = [asset.name, asset.assetTag, asset.serialNumber ?? '', asset.model ?? '', asset.brand ?? ''];

  return [
    ...new Set(
      parts
        .map((p) => p.toLowerCase().trim())
        .filter(Boolean)
        .flatMap((p) => [p, ...p.split(/[\s\-_/]+/)])
        .filter((t) => t.length > 1),
    ),
  ];
}
