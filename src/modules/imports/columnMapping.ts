import type { CustomFieldDefinitionDocument } from '../catalog/index.js';

/**
 * Suggests which column means what.
 *
 * Nobody wants to map twenty columns by hand, and most spreadsheets use
 * recognisable headings. Suggestions are always shown for confirmation rather
 * than applied silently — a wrong guess that imports 5,000 rows into the wrong
 * field is far worse than one the user corrects in ten seconds.
 */

export interface FieldTarget {
  key: string;
  label: string;
  required: boolean;
  /** Headings that map to this field, beyond the label itself. */
  aliases: string[];
}

export const ASSET_TARGETS: FieldTarget[] = [
  { key: 'name', label: 'Name', required: true, aliases: ['asset name', 'description', 'item', 'title'] },
  { key: 'assetTag', label: 'Asset tag', required: false, aliases: ['tag', 'asset id', 'asset number', 'barcode'] },
  { key: 'serialNumber', label: 'Serial number', required: false, aliases: ['serial', 'serial no', 's/n', 'sn'] },
  { key: 'model', label: 'Model', required: false, aliases: ['model number', 'model name'] },
  { key: 'brand', label: 'Brand', required: false, aliases: ['make', 'manufacturer', 'vendor'] },
  // 'state' is deliberately NOT an alias: it is ambiguous between lifecycle
  // state and physical condition, and guessing wrong maps a whole column into
  // the wrong field. An unmapped column is visible in the mapping step; a
  // wrongly-mapped one is not.
  { key: 'condition', label: 'Condition', required: false, aliases: ['grade', 'physical condition'] },
  { key: 'purchaseDate', label: 'Purchase date', required: false, aliases: ['bought', 'acquired', 'date purchased', 'purchased on'] },
  { key: 'purchasePrice', label: 'Purchase price', required: false, aliases: ['price', 'cost', 'value', 'amount'] },
  { key: 'currency', label: 'Currency', required: false, aliases: ['ccy'] },
  { key: 'warrantyExpiresAt', label: 'Warranty expiry', required: false, aliases: ['warranty', 'warranty end', 'warranty until'] },
  { key: 'locationName', label: 'Location', required: false, aliases: ['site', 'office', 'building'] },
  { key: 'departmentName', label: 'Department', required: false, aliases: ['dept', 'team', 'division'] },
  { key: 'assignedToEmail', label: 'Assigned to (email)', required: false, aliases: ['assignee', 'user', 'holder', 'owner', 'employee email'] },
];

export const PERSON_TARGETS: FieldTarget[] = [
  { key: 'firstName', label: 'First name', required: true, aliases: ['forename', 'given name', 'first'] },
  { key: 'lastName', label: 'Last name', required: true, aliases: ['surname', 'family name', 'last'] },
  { key: 'email', label: 'Email', required: false, aliases: ['e-mail', 'work email', 'email address'] },
  { key: 'employeeCode', label: 'Employee code', required: false, aliases: ['employee id', 'staff id', 'payroll number', 'emp no'] },
  { key: 'jobTitle', label: 'Job title', required: false, aliases: ['title', 'role', 'position'] },
  { key: 'phone', label: 'Phone', required: false, aliases: ['telephone', 'mobile', 'contact number'] },
  { key: 'departmentName', label: 'Department', required: false, aliases: ['dept', 'team', 'division'] },
  { key: 'locationName', label: 'Location', required: false, aliases: ['site', 'office', 'building'] },
  { key: 'type', label: 'Type', required: false, aliases: ['employment type', 'worker type'] },
];

export function targetsFor(
  entityType: 'asset' | 'person',
  customFields: CustomFieldDefinitionDocument[] = [],
): FieldTarget[] {
  const base = entityType === 'asset' ? ASSET_TARGETS : PERSON_TARGETS;

  // Custom fields are importable the moment they are defined — the whole point
  // of a dynamic field system is that nothing downstream needs updating.
  const custom = customFields.map<FieldTarget>((field) => ({
    key: `cf.${field.key}`,
    label: field.label,
    required: field.validation?.required ?? false,
    aliases: [field.key.replace(/_/g, ' ')],
  }));

  return [...base, ...custom];
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Maps headers to fields.
 *
 * Exact match first, then alias, then a contains-match as a last resort. A
 * header is never mapped to a field another header already claimed — otherwise
 * "Name" and "Asset Name" both grab `name` and one silently wins.
 */
export function suggestMapping(
  headers: string[],
  targets: FieldTarget[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const claimed = new Set<string>();

  const candidates = targets.map((target) => ({
    key: target.key,
    terms: [normalise(target.label), normalise(target.key), ...target.aliases.map(normalise)],
  }));

  const match = (header: string, predicate: (terms: string[], h: string) => boolean): void => {
    if (mapping[header]) return;
    const h = normalise(header);

    for (const candidate of candidates) {
      if (claimed.has(candidate.key)) continue;
      if (!predicate(candidate.terms, h)) continue;

      mapping[header] = candidate.key;
      claimed.add(candidate.key);
      return;
    }
  };

  // Three passes, most confident first, so a weak contains-match never beats an
  // exact one elsewhere in the file.
  for (const header of headers) match(header, (terms, h) => terms.includes(h));
  for (const header of headers) match(header, (terms, h) => terms.some((t) => t === h));
  for (const header of headers) {
    match(header, (terms, h) => terms.some((t) => t.length > 3 && (h.includes(t) || t.includes(h))));
  }

  return mapping;
}

export function missingRequired(
  mapping: Record<string, string>,
  targets: FieldTarget[],
): FieldTarget[] {
  const mapped = new Set(Object.values(mapping));
  return targets.filter((target) => target.required && !mapped.has(target.key));
}
