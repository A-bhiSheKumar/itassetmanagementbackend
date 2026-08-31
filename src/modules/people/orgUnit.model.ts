import { Schema, type Model, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';

/**
 * Departments, locations and cost centres.
 *
 * One schema shape, three models. They differ only in the extra fields a
 * location carries, and keeping them separate collections means an index on
 * `{tenantId, parentId}` stays small and a location can never be mistaken for a
 * department by an id alone.
 */
function orgUnitSchema(extra: Record<string, unknown> = {}): Schema {
  const schema = new Schema(
    {
      name: { type: String, required: true, trim: true },
      code: { type: String, trim: true, default: null },
      description: { type: String, default: '' },

      parentId: { type: String, default: null },
      /** Ancestor ids, root first. See hierarchy.ts for why. */
      path: { type: [String], default: [] },

      managerId: { type: String, default: null },
      status: { type: String, enum: ['active', 'archived'], default: 'active' },

      ...extra,
    },
    { timestamps: true },
  );

  schema.index({ tenantId: 1, status: 1, name: 1 });
  schema.index({ tenantId: 1, parentId: 1, name: 1 });

  // Subtree queries: "everything under London".
  schema.index({ tenantId: 1, path: 1 });

  // Codes are optional, so uniqueness applies only when one is present — and
  // only among live records, so archiving frees the code for reuse.
  schema.index(
    { tenantId: 1, code: 1 },
    {
      unique: true,
      partialFilterExpression: { code: { $type: 'string' }, deletedAt: null },
    },
  );

  return schema;
}

const departmentSchema = orgUnitSchema();

const locationSchema = orgUnitSchema({
  address: {
    line1: { type: String, default: '' },
    line2: { type: String, default: '' },
    city: { type: String, default: '' },
    region: { type: String, default: '' },
    postcode: { type: String, default: '' },
    country: { type: String, default: '' },
  },
  /**
   * Overrides the tenant timezone for this site. A London-headquartered tenant
   * with a Sydney office needs "due today" to mean the right thing in both.
   */
  timezone: { type: String, default: null },
});

const costCentreSchema = orgUnitSchema();

/**
 * The shape all three share.
 *
 * Declared explicitly rather than inferred, because callers work with whichever
 * model a route selected and should not have to narrow a three-way union for
 * fields that are identical by construction.
 */
export interface OrgUnit {
  name: string;
  code: string | null;
  description: string;
  parentId: string | null;
  path: string[];
  managerId: string | null;
  status: 'active' | 'archived';
  tenantId: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  address?: Record<string, string>;
  timezone?: string | null;
}

export type OrgUnitDocument = HydratedDocument<OrgUnit>;

export const DepartmentModel = defineModel('Department', departmentSchema) as unknown as Model<OrgUnit>;
export const LocationModel = defineModel('Location', locationSchema) as unknown as Model<OrgUnit>;
export const CostCentreModel = defineModel('CostCentre', costCentreSchema) as unknown as Model<OrgUnit>;

export const ORG_UNIT_MODELS: Record<OrgUnitKind, Model<OrgUnit>> = {
  department: DepartmentModel,
  location: LocationModel,
  costCentre: CostCentreModel,
};

export type OrgUnitKind = 'department' | 'location' | 'costCentre';
