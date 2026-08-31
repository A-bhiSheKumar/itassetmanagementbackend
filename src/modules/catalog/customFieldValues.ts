import { Schema } from 'mongoose';

/**
 * Type-bucketed custom field storage (ADR-004).
 *
 * Values are partitioned by type so that each bucket compares correctly:
 *
 *   cf.s.chip              = "M3 Pro"       string, select (stores the option id)
 *   cf.n.ram_gb            = 36             number, currency (minor units)
 *   cf.d.applecare_expiry  = ISODate(...)   date
 *   cf.b.is_encrypted      = true           boolean
 *   cf.r.insurer           = "652f..."      reference to another record
 *   cf.m.tags              = ["a", "b"]     multi-select (option ids)
 *
 * ── Why buckets rather than one map ────────────────────────────────────────
 * In an untyped map every value is a string, so `"16" < "9"` and every range
 * filter, sort and aggregation on a numeric field is silently wrong. Nothing
 * errors; the answers are just incorrect, which is worse. Partitioning by type
 * is what makes `filter[cf.n.ram_gb][gte]=16` mean what it says.
 */

export const CUSTOM_FIELD_BUCKETS = ['s', 'n', 'd', 'b', 'r', 'm'] as const;
export type CustomFieldBucket = (typeof CUSTOM_FIELD_BUCKETS)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'select',
  'url',
  'email',
  'number',
  'currency',
  'date',
  'boolean',
  'multiselect',
  'reference',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** A field's type determines its bucket permanently — see the note on key immutability. */
export const BUCKET_FOR_TYPE: Record<CustomFieldType, CustomFieldBucket> = {
  text: 's',
  textarea: 's',
  select: 's',
  url: 's',
  email: 's',
  number: 'n',
  currency: 'n',
  date: 'd',
  boolean: 'b',
  multiselect: 'm',
  reference: 'r',
};

/** Embedded on every entity that supports custom fields. */
export function customFieldsPath() {
  return {
    type: {
      s: { type: Schema.Types.Mixed, default: () => ({}) },
      n: { type: Schema.Types.Mixed, default: () => ({}) },
      d: { type: Schema.Types.Mixed, default: () => ({}) },
      b: { type: Schema.Types.Mixed, default: () => ({}) },
      r: { type: Schema.Types.Mixed, default: () => ({}) },
      m: { type: Schema.Types.Mixed, default: () => ({}) },
    },
    default: () => ({ s: {}, n: {}, d: {}, b: {}, r: {}, m: {} }),
    _id: false,
  };
}

export interface CustomFieldValues {
  s: Record<string, string>;
  n: Record<string, number>;
  d: Record<string, Date>;
  b: Record<string, boolean>;
  r: Record<string, string>;
  m: Record<string, string[]>;
}

export function emptyCustomFieldValues(): CustomFieldValues {
  return { s: {}, n: {}, d: {}, b: {}, r: {}, m: {} };
}

/** Flattens buckets to `{ key: value }` for API responses and CSV exports. */
export function flattenCustomFields(values: Partial<CustomFieldValues> | undefined) {
  const flat: Record<string, unknown> = {};
  if (!values) return flat;

  for (const bucket of CUSTOM_FIELD_BUCKETS) {
    for (const [key, value] of Object.entries(values[bucket] ?? {})) {
      flat[key] = value;
    }
  }
  return flat;
}

/** The dotted path a filter or sort uses: `cf.n.ram_gb`. */
export function customFieldPath(bucket: CustomFieldBucket, key: string): string {
  return `cf.${bucket}.${key}`;
}
