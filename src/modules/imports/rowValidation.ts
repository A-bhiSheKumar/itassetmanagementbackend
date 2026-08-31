import crypto from 'node:crypto';

/**
 * Per-row parsing and validation.
 *
 * Runs entirely against staged rows, writing nothing to the real collections.
 * That is what makes the preview a genuine dry run: the user sees exactly what
 * would happen before anything happens.
 */

export interface RowError {
  field: string;
  message: string;
}

export interface NormalisedRow {
  values: Record<string, unknown>;
  customFields: Record<string, unknown>;
  errors: RowError[];
}

export type DateOrder = 'DMY' | 'MDY' | 'ISO';

/**
 * Parses a date in the order the USER declared.
 *
 * 03/04/2026 is 3 April to most of the world and 4 March in the US. Guessing is
 * how an import silently shifts every date by months, so the order is chosen at
 * the mapping step and applied here (docs/06-edge-cases.md #47).
 */
export function parseDate(raw: string, order: DateOrder): Date | null {
  const value = raw.trim();
  if (!value) return null;

  // Unambiguous, so honoured whatever order was declared.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(value);
  if (parts) {
    if (order === 'ISO') return null;

    const a = Number(parts[1]);
    const b = Number(parts[2]);
    let year = Number(parts[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;

    const [day, month] = order === 'DMY' ? [a, b] : [b, a];

    // 13 cannot be a month. Rejecting beats silently swapping the fields, which
    // would leave this row inconsistent with the rest of the file.
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return utc(year, month, day);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function utc(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Catches 31 February, which Date would roll forward into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * Money in minor units.
 *
 * Accepts what people actually paste. Rejects anything it cannot read rather
 * than storing a plausible-looking wrong number.
 */
export function parseMoneyMinor(raw: string): number | null {
  const value = raw.trim().replace(/[^0-9.,-]/g, '');
  if (!value) return null;

  // "1.234,56" is European; "1,234.56" is not. The last separator decides.
  const normalised =
    value.lastIndexOf(',') > value.lastIndexOf('.')
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');

  const amount = Number(normalised);
  if (!Number.isFinite(amount)) return null;

  return Math.round(amount * 100);
}

export function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(value)) return true;
  if (['false', 'no', 'n', '0'].includes(value)) return false;
  return null;
}

export interface RowContext {
  entityType: 'asset' | 'person';
  dateFormat: DateOrder;
}

const CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged', 'unknown'];
const PERSON_TYPES = ['employee', 'contractor', 'service_account'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Applies the column mapping and coerces each value to its field's type.
 *
 * Errors accumulate rather than short-circuiting: someone fixing a spreadsheet
 * wants every problem in the row at once, not one per upload.
 */
export function normaliseRow(
  raw: Record<string, string>,
  mapping: Record<string, string>,
  context: RowContext,
): NormalisedRow {
  const values: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  const errors: RowError[] = [];

  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue;

    const rawValue = (raw[header] ?? '').trim();

    if (target.startsWith('cf.')) {
      // Custom field values are checked by the tenant's own compiled schema at
      // commit time, which is the single source of truth for their rules.
      if (rawValue !== '') customFields[target.slice(3)] = rawValue;
      continue;
    }

    if (rawValue === '') continue;

    switch (target) {
      case 'purchaseDate':
      case 'warrantyExpiresAt': {
        const date = parseDate(rawValue, context.dateFormat);
        if (!date) {
          errors.push({
            field: target,
            message: `"${rawValue}" is not a date we can read in ${context.dateFormat} order.`,
          });
        } else {
          values[target] = date;
        }
        break;
      }

      case 'purchasePrice': {
        const minor = parseMoneyMinor(rawValue);
        if (minor === null) {
          errors.push({ field: target, message: `"${rawValue}" is not an amount.` });
        } else {
          values[target] = minor;
        }
        break;
      }

      case 'condition': {
        const condition = rawValue.toLowerCase();
        if (!CONDITIONS.includes(condition)) {
          errors.push({
            field: target,
            message: `"${rawValue}" is not a condition. Use one of: ${CONDITIONS.join(', ')}.`,
          });
        } else {
          values[target] = condition;
        }
        break;
      }

      case 'type': {
        const type = rawValue.toLowerCase().replace(/\s+/g, '_');
        if (!PERSON_TYPES.includes(type)) {
          errors.push({
            field: target,
            message: `"${rawValue}" is not a type. Use one of: ${PERSON_TYPES.join(', ')}.`,
          });
        } else {
          values[target] = type;
        }
        break;
      }

      case 'email':
      case 'assignedToEmail': {
        const email = rawValue.toLowerCase();
        if (!EMAIL.test(email)) {
          errors.push({ field: target, message: `"${rawValue}" is not an email address.` });
        } else {
          values[target] = email;
        }
        break;
      }

      case 'currency': {
        const code = rawValue.toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) {
          errors.push({ field: target, message: `"${rawValue}" is not a 3-letter currency code.` });
        } else {
          values[target] = code;
        }
        break;
      }

      default:
        values[target] = rawValue;
    }
  }

  // Required fields checked AFTER coercion, so a value that failed to parse
  // reports its real problem rather than "missing".
  const required = context.entityType === 'asset' ? ['name'] : ['firstName', 'lastName'];
  for (const field of required) {
    if (values[field] === undefined || values[field] === '') {
      errors.push({ field, message: 'Required.' });
    }
  }

  return { values, customFields, errors };
}

/**
 * Identity hash for a row.
 *
 * Keyed on what identifies the record rather than every column, so re-uploading
 * a corrected file still recognises the same row. Unique per job, which is what
 * makes a resumed or retried commit safe.
 */
export function hashRow(
  values: Record<string, unknown>,
  rowNumber: number,
  entityType: 'asset' | 'person',
): string {
  const identity =
    entityType === 'asset'
      ? [values.serialNumber, values.assetTag, values.name]
      : [values.email, values.employeeCode, values.firstName, values.lastName];

  // The row number is part of it because two genuinely identical lines do occur
  // in real spreadsheets, and they are two rows, not silently one.
  const material = [...identity.map((v) => String(v ?? '')), rowNumber].join(' ');

  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}
