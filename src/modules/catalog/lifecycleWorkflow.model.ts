import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

/**
 * A configurable state machine for asset lifecycle (ADR-006).
 *
 * States and the transitions between them are DATA, so a tenant can model their
 * own process — "awaiting imaging", "with the courier" — without a deploy. The
 * engine refuses any transition not declared here, which is what stops an asset
 * going from `disposed` back to `in_stock` because someone clicked the wrong
 * button.
 */
const stateSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    colour: { type: String, default: null },
    /**
     * Groups states for dashboard tiles without hardcoding tenant-specific keys:
     * a tenant's "with the courier" can still count as `in_transit`.
     */
    category: {
      type: String,
      enum: ['pending', 'available', 'deployed', 'maintenance', 'retired'],
      default: 'available',
    },
    /** Terminal states allow no outbound transition. */
    isTerminal: { type: Boolean, default: false },
  },
  { _id: false },
);

const transitionSchema = new Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    label: { type: String, required: true },

    /** Checked against the actor's effective permissions before the move. */
    requiredPermission: { type: String, default: 'asset:transition' },

    /** Fields that must be non-empty for this move — "why was it written off?" */
    requiredFields: { type: [String], default: [] },

    /**
     * Preconditions the engine evaluates. `no_active_assignment` is the one
     * that stops an asset being retired while someone still has it.
     */
    guards: {
      type: [String],
      default: [],
      enum: ['no_active_assignment', 'has_assignment', 'not_under_maintenance'],
    },

    /** Side effects run inside the same transaction as the state change. */
    effects: { type: [String], default: [], enum: ['unassign', 'notify_assignee', 'notify_manager'] },

    requiresComment: { type: Boolean, default: false },
  },
  { _id: false },
);

const lifecycleWorkflowSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    isDefault: { type: Boolean, default: false },

    states: { type: [stateSchema], required: true },
    transitions: { type: [transitionSchema], default: [] },
    initialState: { type: String, required: true },

    /**
     * Incremented on every edit. Assets record the version they were last moved
     * under, so a historical transition stays interpretable after the workflow
     * changes (docs/06-edge-cases.md #18).
     */
    version: { type: Number, default: 1 },
  },
  { timestamps: true },
);

lifecycleWorkflowSchema.index({ tenantId: 1, isDefault: 1 });
lifecycleWorkflowSchema.index({ tenantId: 1, name: 1 });

export type LifecycleWorkflow = InferSchemaType<typeof lifecycleWorkflowSchema>;
export type LifecycleWorkflowDocument = HydratedDocument<LifecycleWorkflow>;

export const LifecycleWorkflowModel = defineModel('LifecycleWorkflow', lifecycleWorkflowSchema);

/**
 * Seeded into every new tenant so nobody has to configure anything to start.
 *
 * Deliberately short. A default with fifteen states looks thorough and gets
 * deleted; five states people actually use get extended.
 */
export const DEFAULT_WORKFLOW = {
  name: 'Standard asset lifecycle',
  isDefault: true,
  initialState: 'in_stock',
  states: [
    { key: 'ordered', label: 'On order', category: 'pending', colour: 'muted' },
    { key: 'in_stock', label: 'In stock', category: 'available', colour: 'accent' },
    { key: 'deployed', label: 'Deployed', category: 'deployed', colour: 'success' },
    { key: 'maintenance', label: 'Under maintenance', category: 'maintenance', colour: 'warning' },
    { key: 'retired', label: 'Retired', category: 'retired', colour: 'muted', isTerminal: false },
    { key: 'disposed', label: 'Disposed', category: 'retired', colour: 'muted', isTerminal: true },
    { key: 'lost', label: 'Lost or stolen', category: 'retired', colour: 'danger', isTerminal: true },
  ],
  transitions: [
    { from: 'ordered', to: 'in_stock', label: 'Mark received' },
    { from: 'in_stock', to: 'deployed', label: 'Deploy', guards: ['has_assignment'] },
    { from: 'deployed', to: 'in_stock', label: 'Return to stock', guards: ['no_active_assignment'] },
    { from: 'in_stock', to: 'maintenance', label: 'Send for maintenance' },
    { from: 'deployed', to: 'maintenance', label: 'Send for maintenance' },
    { from: 'maintenance', to: 'in_stock', label: 'Return from maintenance' },
    {
      from: 'in_stock',
      to: 'retired',
      label: 'Retire',
      requiredPermission: 'asset:transition',
      guards: ['no_active_assignment'],
      requiresComment: true,
    },
    {
      from: 'maintenance',
      to: 'retired',
      label: 'Retire — beyond repair',
      guards: ['no_active_assignment'],
      requiresComment: true,
    },
    /**
     * Declared even though it always fails while someone holds the asset.
     *
     * Without it the engine answers "you can't go straight there", which is
     * true but unhelpful. With it, the guard answers "this asset is still
     * assigned — return it first", which is the actual blocker and tells the
     * user what to do.
     */
    {
      from: 'deployed',
      to: 'retired',
      label: 'Retire',
      guards: ['no_active_assignment'],
      requiresComment: true,
    },
    { from: 'retired', to: 'disposed', label: 'Mark disposed', requiresComment: true },
    { from: 'in_stock', to: 'lost', label: 'Report lost', requiresComment: true },
    { from: 'deployed', to: 'lost', label: 'Report lost', requiresComment: true },
  ],
} as const;
