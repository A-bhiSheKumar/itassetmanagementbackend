import { stringify } from 'csv-stringify/sync';

/**
 * CSV output, with the one protection every export needs.
 *
 * ── Formula injection ─────────────────────────────────────────────────────
 * A cell beginning with =, +, - or @ is a FORMULA to Excel, Sheets and
 * LibreOffice. An attacker who can set an asset name to
 *
 *     =cmd|'/c calc'!A1
 *
 * has not attacked us — they have attacked whoever opens our export, using our
 * file as the delivery mechanism. Prefixing with an apostrophe makes the cell
 * literal text and is invisible in the spreadsheet.
 *
 * This is a real, commonly-missed vulnerability: the data is stored perfectly
 * safely and only becomes dangerous on the way out.
 */

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function neutraliseFormula(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  // A leading apostrophe is Excel's own "treat this as text" marker. It does
  // not appear in the rendered cell.
  return DANGEROUS_PREFIX.test(text) ? `'${text}` : text;
}

export interface CsvColumn<T> {
  header: string;
  value(row: T): unknown;
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const records = rows.map((row) =>
    columns.map((column) => neutraliseFormula(column.value(row))),
  );

  return stringify([columns.map((c) => c.header), ...records], {
    // Excel needs the BOM to read UTF-8 correctly; without it, accented names
    // arrive mangled and users conclude the export is broken.
    bom: true,
  });
}

/** A blank file with only headings — the "download a template" flow. */
export function toTemplate(columns: string[], example?: Record<string, string>): string {
  const rows: string[][] = [columns];
  if (example) rows.push(columns.map((c) => neutraliseFormula(example[c] ?? '')));

  return stringify(rows, { bom: true });
}
