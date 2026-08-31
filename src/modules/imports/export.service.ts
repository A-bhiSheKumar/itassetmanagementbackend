import { AssetModel, buildAssetFilter, type AssetFilters } from '../assets/index.js';
import { PersonModel, DepartmentModel, LocationModel } from '../people/index.js';
import { flattenCustomFields, definitionsFor } from '../catalog/index.js';
import { ImportRowModel } from './importRow.model.js';
import { toCsv, toTemplate, type CsvColumn } from './csvWriter.js';
import { ASSET_TARGETS, PERSON_TARGETS } from './columnMapping.js';

/**
 * Exports.
 *
 * Every column goes through the formula neutraliser in csvWriter — the data is
 * stored safely and only becomes dangerous on the way out.
 */

/** Bounded: an unbounded export is a memory incident waiting for a big tenant. */
const MAX_EXPORT_ROWS = 50_000;

function lookupMap(rows: Array<{ _id: unknown; name: string }>): Map<string, string> {
  return new Map(rows.map((r) => [String(r._id), r.name]));
}

export async function exportAssets(filters: AssetFilters = {}): Promise<string> {
  const filter = await buildAssetFilter(filters);

  const [rows, departments, locations, customFields] = await Promise.all([
    AssetModel.find(filter).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean(),
    DepartmentModel.find({}).select('name').lean(),
    LocationModel.find({}).select('name').lean(),
    definitionsFor({ appliesTo: 'asset' }),
  ]);

  const departmentName = lookupMap(departments as never);
  const locationName = lookupMap(locations as never);

  // Names, not ids: an export is for humans and for re-import, and an id in a
  // spreadsheet is useful to neither.
  const columns: Array<CsvColumn<(typeof rows)[number]>> = [
    { header: 'Asset tag', value: (a) => a.assetTag },
    { header: 'Name', value: (a) => a.name },
    { header: 'Serial number', value: (a) => a.serialNumber },
    { header: 'Brand', value: (a) => a.brand },
    { header: 'Model', value: (a) => a.model },
    // Named in full so a round-trip import cannot mistake it for condition.
    { header: 'Lifecycle state', value: (a) => a.lifecycleState },
    { header: 'Condition', value: (a) => a.condition },
    { header: 'Location', value: (a) => locationName.get(String(a.placement?.locationId)) ?? '' },
    { header: 'Department', value: (a) => departmentName.get(String(a.placement?.departmentId)) ?? '' },
    { header: 'Purchase date', value: (a) => isoDate(a.purchase?.date) },
    // Major units, because that is what a person reading a spreadsheet expects.
    { header: 'Purchase price', value: (a) => minorToMajor(a.purchase?.priceMinor) },
    { header: 'Currency', value: (a) => a.purchase?.currency },
    { header: 'Warranty expiry', value: (a) => isoDate(a.warranty?.expiresAt) },
    { header: 'Assigned to', value: (a) => a.currentAssignment?.assigneeId ?? '' },
  ];

  // Tenant-defined columns appear automatically — a field added this morning is
  // in this afternoon's export with no code change.
  for (const field of customFields) {
    columns.push({
      header: field.label,
      value: (a) => flattenCustomFields(a.cf as never)[field.key],
    });
  }

  return toCsv(rows, columns);
}

export async function exportPeople(): Promise<string> {
  const [rows, departments, locations, customFields] = await Promise.all([
    PersonModel.find({}).sort({ lastName: 1 }).limit(MAX_EXPORT_ROWS).lean(),
    DepartmentModel.find({}).select('name').lean(),
    LocationModel.find({}).select('name').lean(),
    definitionsFor({ appliesTo: 'person' }),
  ]);

  const departmentName = lookupMap(departments as never);
  const locationName = lookupMap(locations as never);

  const columns: Array<CsvColumn<(typeof rows)[number]>> = [
    { header: 'First name', value: (p) => p.firstName },
    { header: 'Last name', value: (p) => p.lastName },
    { header: 'Email', value: (p) => p.email },
    { header: 'Employee code', value: (p) => p.employeeCode },
    { header: 'Job title', value: (p) => p.jobTitle },
    { header: 'Phone', value: (p) => p.phone },
    { header: 'Type', value: (p) => p.type },
    { header: 'Status', value: (p) => p.status },
    { header: 'Department', value: (p) => departmentName.get(String(p.departmentId)) ?? '' },
    { header: 'Location', value: (p) => locationName.get(String(p.locationId)) ?? '' },
  ];

  for (const field of customFields) {
    columns.push({
      header: field.label,
      value: (p) => flattenCustomFields(p.cf as never)[field.key],
    });
  }

  return toCsv(rows, columns);
}

/**
 * Just the rows that failed, with their reasons.
 *
 * The point of the whole staged pipeline: fix twelve rows in this file and
 * re-upload, rather than hunting through the original 5,000.
 */
export async function exportImportErrors(importJobId: string): Promise<string> {
  const rows = await ImportRowModel.find({
    importJobId,
    status: { $in: ['invalid', 'failed'] },
  })
    .sort({ rowNumber: 1 })
    .lean();

  // The original headers are preserved so the corrected file can be uploaded
  // straight back with the same mapping.
  const originalHeaders = [...new Set(rows.flatMap((r) => Object.keys(r.raw ?? {})))];

  const columns: Array<CsvColumn<(typeof rows)[number]>> = [
    { header: 'Row', value: (r) => r.rowNumber },
    {
      header: 'Problem',
      value: (r) => (r.issues ?? []).map((e) => `${e.field}: ${e.message}`).join('; '),
    },
    ...originalHeaders.map((header) => ({
      header,
      value: (r: (typeof rows)[number]) => (r.raw as Record<string, string>)?.[header] ?? '',
    })),
  ];

  return toCsv(rows, columns);
}

/** A blank file with the right headings and one worked example. */
export function importTemplate(entityType: 'asset' | 'person'): string {
  const targets = entityType === 'asset' ? ASSET_TARGETS : PERSON_TARGETS;
  const headers = targets.map((t) => t.label);

  const example: Record<string, string> =
    entityType === 'asset'
      ? {
          Name: 'MacBook Pro 14',
          'Serial number': 'C02XY1234',
          Brand: 'Apple',
          Model: 'M3 Pro',
          Condition: 'good',
          'Purchase date': '14/03/2026',
          'Purchase price': '1999.00',
          Currency: 'GBP',
        }
      : {
          'First name': 'Ada',
          'Last name': 'Okafor',
          Email: 'ada.okafor@example.com',
          'Employee code': 'EMP-001',
          'Job title': 'Field engineer',
          Type: 'employee',
        };

  return toTemplate(headers, example);
}

function isoDate(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function minorToMajor(minor: unknown): string {
  if (minor === null || minor === undefined) return '';
  return (Number(minor) / 100).toFixed(2);
}
