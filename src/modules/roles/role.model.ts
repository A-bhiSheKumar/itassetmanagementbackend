import { defineModel } from '../../core/db/index.js';
import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { ALL_PERMISSIONS } from '../../core/authz/index.js';

/**
 * A named set of permissions, scoped to one tenant.
 *
 * System roles (Owner/Admin/Manager/Member) are seeded into each tenant on
 * creation rather than living globally — see the note in core/authz/permissions.ts.
 * Custom roles in v1.2 are the same shape, so the role editor needs no special
 * cases.
 */
const roleSchema = new Schema(
  {
    key: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    permissions: {
      type: [String],
      required: true,
      // Validated against the registry, so a typo cannot create a permission
      // that no route will ever check and that quietly grants nothing.
      validate: {
        validator: (values: string[]) =>
          values.every((v) => (ALL_PERMISSIONS as string[]).includes(v)),
        message: 'Contains a permission that does not exist.',
      },
    },

    /** System roles cannot have their permissions edited or be deleted. */
    isSystem: { type: Boolean, default: false },

    scopeType: {
      type: String,
      enum: ['all', 'department', 'location', 'own'],
      default: 'all',
    },
  },
  { timestamps: true },
);

roleSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
roleSchema.index({ tenantId: 1, isSystem: 1 });

export type Role = InferSchemaType<typeof roleSchema>;
export type RoleDocument = HydratedDocument<Role>;

export const RoleModel = defineModel('Role', roleSchema);
