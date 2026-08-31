import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { defineModel } from '../../core/db/index.js';
import { customFieldsPath } from '../catalog/index.js';

/**
 * Someone who can hold an asset (ADR-003).
 *
 * NOT a login. A contractor, a warehouse hand or a departed employee can hold
 * equipment without ever signing in, and a Person that becomes a user is linked
 * to a Membership rather than merged with one. That separation is what lets us
 * charge for seats instead of headcount.
 */
const personSchema = new Schema(
  {
    employeeCode: { type: String, trim: true, default: null },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    /** Work email. Optional — plenty of asset holders have none. */
    email: { type: String, trim: true, lowercase: true, default: null },
    phone: { type: String, trim: true, default: null },
    jobTitle: { type: String, trim: true, default: '' },

    departmentId: { type: String, default: null },
    locationId: { type: String, default: null },
    costCentreId: { type: String, default: null },
    managerId: { type: String, default: null },

    /** Set once this person also has a login. */
    membershipId: { type: String, default: null },

    type: {
      type: String,
      enum: ['employee', 'contractor', 'service_account'],
      default: 'employee',
    },

    /**
     * `offboarding` is a real state, not a synonym for inactive: it means they
     * still hold equipment that has to come back (docs/06-edge-cases.md #2).
     */
    status: {
      type: String,
      enum: ['active', 'on_leave', 'offboarding', 'inactive'],
      default: 'active',
    },

    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },

    /**
     * Correlates this record with Entra ID, Okta or an HRIS. Present from M2
     * even though sync ships in v2 — matching identities onto records created
     * by hand later is the painful version of this problem.
     */
    externalRefs: {
      type: [{ system: String, id: String, _id: false }],
      default: [],
    },

    /** Lowercased, de-punctuated tokens for typeahead. */
    searchTokens: { type: [String], default: [] },

    cf: customFieldsPath(),
  },
  { timestamps: true },
);

// Default list: active people, sorted by surname. ESR — equality on tenant and
// status, then the sort key.
personSchema.index({ tenantId: 1, status: 1, lastName: 1, firstName: 1 });

// Email and employee code are unique WHEN PRESENT and among live records. A
// plain unique index would allow exactly one person without an email per tenant.
personSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' }, deletedAt: null } },
);
personSchema.index(
  { tenantId: 1, employeeCode: 1 },
  { unique: true, partialFilterExpression: { employeeCode: { $type: 'string' }, deletedAt: null } },
);

// Filters, and the extra clause a department- or location-scoped role adds.
personSchema.index({ tenantId: 1, departmentId: 1, status: 1 });
personSchema.index({ tenantId: 1, locationId: 1, status: 1 });

// Direct reports — the offboarding screen walks this.
personSchema.index({ tenantId: 1, managerId: 1 });

personSchema.index({ tenantId: 1, membershipId: 1 }, { sparse: true });

// Directory sync idempotency: find the record this external identity maps to.
personSchema.index({ tenantId: 1, 'externalRefs.system': 1, 'externalRefs.id': 1 });

personSchema.index({ tenantId: 1, searchTokens: 1 });

// Cursor pagination. _id breaks ties so the cursor is stable under concurrent writes.
personSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });

export type Person = InferSchemaType<typeof personSchema>;
export type PersonDocument = HydratedDocument<Person>;

export const PersonModel = defineModel('Person', personSchema);

/** Tokens for typeahead: "Ada Okafor" → ada, okafor, ada okafor, ADA-001. */
export function buildSearchTokens(person: {
  firstName: string;
  lastName: string;
  email?: string | null;
  employeeCode?: string | null;
  jobTitle?: string;
}): string[] {
  const parts = [
    person.firstName,
    person.lastName,
    `${person.firstName} ${person.lastName}`,
    person.email ?? '',
    person.employeeCode ?? '',
    person.jobTitle ?? '',
  ];

  return [
    ...new Set(
      parts
        .map((p) => p.toLowerCase().trim())
        .filter(Boolean)
        .flatMap((p) => [p, ...p.split(/[\s@._-]+/)])
        .filter((t) => t.length > 1),
    ),
  ];
}
