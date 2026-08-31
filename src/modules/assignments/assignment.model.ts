import { Schema, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, type Scoped } from '../../core/db/index.js';

/**
 * Who holds what, and who held it before.
 *
 * Assignments are their own collection, never an array on the asset. A
 * five-year-old laptop accumulates dozens of entries; unbounded arrays destroy
 * write performance long before the 16 MB document cap, and they cannot be
 * queried across assets — "everything Ada holds" would mean scanning every
 * asset in the tenant.
 */
const assignmentSchema = new Schema(
  {
    assetId: { type: String, required: true },

    /**
     * Polymorphic on purpose: a laptop held by a person, a monitor allocated to
     * a meeting room, a dock attached to a laptop. One mechanism, not three.
     */
    assigneeType: { type: String, required: true, enum: ['person', 'location', 'asset'] },
    assigneeId: { type: String, required: true },

    status: { type: String, required: true, enum: ['active', 'returned', 'cancelled'], default: 'active' },

    assignedBy: { type: String, default: null },
    assignedAt: { type: Date, required: true, default: () => new Date() },
    /** For loanable pool assets (v1.2). Present now so overdue reporting is cheap later. */
    dueAt: { type: Date, default: null },

    acknowledgement: {
      requiredAt: { type: Date, default: null },
      acknowledgedAt: { type: Date, default: null },
      /** Hashed. The plaintext only ever exists in the email that was sent. */
      tokenHash: { type: String, default: null },
      method: { type: String, enum: ['link', 'signature', 'in_person', null], default: null },
    },

    returnedAt: { type: Date, default: null },
    returnedTo: { type: String, default: null },

    conditionOut: { type: String, default: null },
    conditionIn: { type: String, default: null },

    notes: { type: String, default: '' },
    /** Chain of custody: what this assignment replaced. */
    previousAssignmentId: { type: String, default: null },
  },
  { timestamps: true },
);

/**
 * ★ The most important index in the system (ADR-005).
 *
 * The DATABASE refuses a second active assignment for an asset. Two admins
 * clicking "Assign" at the same moment: one commits, the other gets E11000,
 * which the service translates into 409 ASSET_ALREADY_ASSIGNED naming the
 * current holder.
 *
 * No application lock, no read-then-write race, no reconciliation script. The
 * partial filter is what allows the same asset to have many RETURNED
 * assignments — the whole history — while only ever one active.
 */
assignmentSchema.index(
  { tenantId: 1, assetId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

// Everything a person holds now, plus their full history. Powers offboarding.
assignmentSchema.index({ tenantId: 1, assigneeId: 1, status: 1, assignedAt: -1 });

// Chain of custody for one asset.
assignmentSchema.index({ tenantId: 1, assetId: 1, assignedAt: -1 });

// Overdue loans (v1.2).
assignmentSchema.index(
  { tenantId: 1, status: 1, dueAt: 1 },
  { partialFilterExpression: { dueAt: { $type: 'date' } } },
);

// Pending acknowledgements — a dashboard "needs attention" row.
assignmentSchema.index(
  { tenantId: 1, 'acknowledgement.requiredAt': 1 },
  { partialFilterExpression: { 'acknowledgement.acknowledgedAt': null } },
);

export type Assignment = Scoped<InferSchemaType<typeof assignmentSchema>>;
export type AssignmentDocument = HydratedDocument<Assignment>;

export const AssignmentModel = defineModel(
  'Assignment',
  assignmentSchema,
) as unknown as Model<Assignment>;
