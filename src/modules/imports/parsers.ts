import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { ValidationError } from '../../core/errors/index.js';

/**
 * Turns an uploaded file into headers and rows.
 *
 * Both formats produce the same shape, so everything downstream — mapping,
 * validation, commit — is written once.
 */

export interface ParsedFile {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Guards against a "spreadsheet" that is really a 2 GB log file. */
const MAX_ROWS = 50_000;

export function detectFormat(fileName: string): 'csv' | 'xlsx' {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'csv' || extension === 'txt') return 'csv';
  if (extension === 'xlsx' || extension === 'xlsm') return 'xlsx';

  throw new ValidationError('Upload a .csv or .xlsx file.', {
    fileName: ['Only CSV and Excel files can be imported.'],
  });
}

export function parseCsv(content: Buffer): ParsedFile {
  let records: Array<Record<string, string>>;

  try {
    records = parse(content, {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      // A ragged row is a data problem to report per row, not a reason to
      // reject the whole file — the user cannot fix what they cannot see.
      relax_column_count: true,
      trim: true,
      // Strips a UTF-8 BOM, which Excel writes and which otherwise turns the
      // first header into "﻿Asset Tag" and silently unmaps it.
      bom: true,
      to: MAX_ROWS + 1,
    }) as Array<Record<string, string>>;
  } catch (err) {
    throw new ValidationError(
      `That file could not be read as CSV: ${(err as Error).message}`,
      { file: ['Not valid CSV.'] },
    );
  }

  assertSize(records.length);

  return {
    headers: records.length > 0 ? Object.keys(records[0]!) : [],
    rows: records,
  };
}

export async function parseXlsx(content: Buffer): Promise<ParsedFile> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError('That file could not be read as an Excel workbook.', {
      file: ['Not a valid .xlsx file.'],
    });
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new ValidationError('That workbook has no sheets.', { file: ['Empty workbook.'] });
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    headers[column - 1] = String(cell.value ?? '').trim();
  });

  if (headers.filter(Boolean).length === 0) {
    throw new ValidationError('The first row must contain column headings.', {
      file: ['No headings found.'],
    });
  }

  const rows: Array<Record<string, string>> = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || rows.length > MAX_ROWS) return;

    const record: Record<string, string> = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellToString(row.getCell(index + 1).value);
      record[header] = value;
      if (value !== '') hasValue = true;
    });

    // Excel files are full of trailing blank rows that look empty but are not.
    if (hasValue) rows.push(record);
  });

  assertSize(rows.length);

  return { headers: headers.filter(Boolean), rows };
}

/**
 * Excel cells are not strings.
 *
 * A cell can hold a Date, a formula result, rich text, an error, or a hyperlink
 * object. Coercing with String() would give "[object Object]" for several of
 * them — which then fails validation with a message about nothing.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const cell = value as unknown as Record<string, unknown>;
    if ('text' in cell) return String(cell.text ?? '').trim();
    if ('result' in cell) return String(cell.result ?? '').trim();
    if ('richText' in cell) {
      return (cell.richText as Array<{ text: string }>).map((r) => r.text).join('').trim();
    }
    if ('error' in cell) return '';
    if ('hyperlink' in cell) return String(cell.hyperlink ?? '').trim();
  }
  return String(value).trim();
}

function assertSize(count: number): void {
  if (count > MAX_ROWS) {
    throw new ValidationError(
      `That file has more than ${MAX_ROWS.toLocaleString()} rows. Split it and import in parts.`,
      { file: ['Too many rows.'] },
    );
  }
}

export async function parseFile(fileName: string, content: Buffer): Promise<ParsedFile> {
  return detectFormat(fileName) === 'csv' ? parseCsv(content) : parseXlsx(content);
}
