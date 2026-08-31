import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { ensurePlansSeeded, seedTenant, raiseLimits, type SeededTenant } from '../helpers/factories.js';

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;
let laptopTypeId: string;

function as(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${t.accessToken}`);
}

/** Uploads a file and returns the created import job. */
async function upload(fileName: string, body: string, entityType = 'asset') {
  // An asset import must declare its type — it decides the tag prefix, the
  // applicable custom fields and the lifecycle.
  const typeParam = entityType === 'asset' ? `&assetTypeId=${laptopTypeId}` : '';

  return as(
    request(server())
      .post(
        `/api/v1/imports?entityType=${entityType}&fileName=${encodeURIComponent(fileName)}${typeParam}`,
      )
      .set('Content-Type', 'text/csv')
      .send(body),
  );
}

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}

/** Drives upload → map → validate, returning the job at preview. */
async function stage(
  fileName: string,
  body: string,
  options: Record<string, unknown> = {},
  entityType = 'asset',
) {
  const created = await upload(fileName, body, entityType);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id;

  const mapped = await as(
    request(server())
      .patch(`/api/v1/imports/${id}/mapping`)
      .send({ columnMapping: created.body.data.columnMapping, ...options }),
  );

  if (mapped.status !== 200) return { id, created, mapped, validated: null };

  const validated = await as(request(server()).post(`/api/v1/imports/${id}/validate`));
  return { id, created, mapped, validated };
}

beforeEach(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'imports');

  const types = await as(request(server()).get('/api/v1/catalog/asset-types'));
  laptopTypeId = types.body.data.find((x: { key: string }) => x.key === 'laptop').id;
});

describe('upload and column mapping', () => {
  it('detects headers and suggests a mapping', async () => {
    const res = await upload(
      'assets.csv',
      csv([
        ['Asset Name', 'Serial No', 'Manufacturer', 'Date Purchased'],
        ['MacBook Pro', 'C02X1', 'Apple', '14/03/2026'],
      ]),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.detectedHeaders).toEqual([
      'Asset Name',
      'Serial No',
      'Manufacturer',
      'Date Purchased',
    ]);

    // Aliases, not exact matches — real spreadsheets never use our field names.
    expect(res.body.data.columnMapping).toMatchObject({
      'Asset Name': 'name',
      'Serial No': 'serialNumber',
      Manufacturer: 'brand',
      'Date Purchased': 'purchaseDate',
    });
  });

  it('never maps two columns to the same field', async () => {
    const res = await upload('assets.csv', csv([['Name', 'Asset Name'], ['A', 'B']]));

    const mapped = Object.values(res.body.data.columnMapping);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('strips a UTF-8 BOM so the first column still maps', async () => {
    // Excel writes a BOM. Without stripping it the first header becomes
    // "﻿Name" and silently maps to nothing.
    const res = await upload('assets.csv', `﻿${csv([['Name'], ['A laptop']])}`);

    expect(res.body.data.detectedHeaders[0]).toBe('Name');
    expect(res.body.data.columnMapping.Name).toBe('name');
  });

  it('refuses to continue while a required column is unmapped', async () => {
    const created = await upload('assets.csv', csv([['Serial'], ['C02X1']]));

    const res = await as(
      request(server()).patch(`/api/v1/imports/${created.body.data.id}/mapping`).send({
        columnMapping: { Serial: 'serialNumber' },
      }),
    );

    // Caught before any row is read, rather than reporting 5,000 broken rows.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Name');
  });

  it('rejects a file type it cannot read', async () => {
    const res = await upload('notes.docx', 'anything');
    expect(res.status).toBe(422);
  });

  it('rejects a file with no data rows', async () => {
    const res = await upload('assets.csv', csv([['Name', 'Serial']]));
    expect(res.status).toBe(422);
  });
});

describe('Excel files', () => {
  /** Builds a real .xlsx in memory, with the cell types a real workbook has. */
  async function buildWorkbook(): Promise<Buffer> {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Assets');

    sheet.addRow(['Asset Name', 'Serial No', 'Date Purchased', 'Cost']);
    // A real Date, not a string — Excel stores dates as numbers and exceljs
    // hands them back as Date objects.
    sheet.addRow(['MacBook Pro', 'XL-1', new Date(Date.UTC(2026, 2, 14)), 1299]);
    sheet.addRow(['ThinkPad X1', 'XL-2', new Date(Date.UTC(2026, 5, 1)), 999.5]);
    // Trailing blank rows, which every real spreadsheet has.
    sheet.addRow([]);
    sheet.addRow([]);

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it('parses a real workbook, including dates and blank rows', async () => {
    const xlsx = await buildWorkbook();

    const created = await as(
      request(server())
        .post(
          `/api/v1/imports?entityType=asset&fileName=assets.xlsx&assetTypeId=${laptopTypeId}`,
        )
        .set('Content-Type', 'application/octet-stream')
        .send(xlsx),
    );

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.fileFormat).toBe('xlsx');
    // The two trailing blank rows must not become two empty records.
    expect(created.body.data.counts.total).toBe(2);
    expect(created.body.data.detectedHeaders).toEqual([
      'Asset Name',
      'Serial No',
      'Date Purchased',
      'Cost',
    ]);
  });

  it('imports a workbook end to end', async () => {
    const xlsx = await buildWorkbook();

    const created = await as(
      request(server())
        .post(
          `/api/v1/imports?entityType=asset&fileName=assets.xlsx&assetTypeId=${laptopTypeId}`,
        )
        .set('Content-Type', 'application/octet-stream')
        .send(xlsx),
    );

    const id = created.body.data.id;

    await as(
      request(server())
        .patch(`/api/v1/imports/${id}/mapping`)
        .send({ columnMapping: created.body.data.columnMapping, dateFormat: 'ISO' }),
    ).expect(200);

    const validated = await as(request(server()).post(`/api/v1/imports/${id}/validate`));
    expect(validated.body.data.counts.valid, JSON.stringify(validated.body.data.counts)).toBe(2);

    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data).toHaveLength(2);
    // A Date cell comes back as a Date, and must survive as one.
    expect(assets.body.data.map((a: { purchase: { date: string } }) => a.purchase.date).join()).toContain(
      '2026-03-14',
    );
  });

  it('rejects a file that claims to be xlsx but is not', async () => {
    const res = await as(
      request(server())
        .post(
          `/api/v1/imports?entityType=asset&fileName=fake.xlsx&assetTypeId=${laptopTypeId}`,
        )
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('this is not a workbook')),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Excel');
  });
});

describe('the dry run', () => {
  it('reports what would happen without writing anything', async () => {
    const { validated } = await stage(
      'assets.csv',
      csv([
        ['Name', 'Serial'],
        ['Good one', 'S1'],
        ['Another', 'S2'],
      ]),
    );

    expect(validated!.body.data.status).toBe('preview');
    expect(validated!.body.data.counts).toMatchObject({ total: 2, valid: 2, invalid: 0 });

    // Nothing written yet — that is the whole point of staging.
    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data).toHaveLength(0);
  });

  it('reads dates in the order the user declared, not a guess', async () => {
    // A serial is included because the laptop type requires one — the same
    // rule the API enforces, applied identically on import.
    const file = csv([
      ['Name', 'Serial', 'Date Purchased'],
      ['A laptop', 'DATE-1', '03/04/2026'],
    ]);

    const dmy = await stage('a.csv', file, { dateFormat: 'DMY' });
    const mdy = await stage(
      'b.csv',
      file.replace('DATE-1', 'DATE-2'),
      { dateFormat: 'MDY' },
    );

    const dmyRows = await as(request(server()).get(`/api/v1/imports/${dmy.id}/rows`));
    const mdyRows = await as(request(server()).get(`/api/v1/imports/${mdy.id}/rows`));

    expect(dmyRows.body.data[0].errors).toHaveLength(0);
    expect(mdyRows.body.data[0].errors).toHaveLength(0);

    // Same string, two different dates. Guessing is how an import silently
    // shifts every date by months.
    await as(request(server()).post(`/api/v1/imports/${dmy.id}/commit`)).expect(202);

    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data[0].purchase.date).toContain('2026-04-03');
  });

  it('rejects an impossible date rather than rolling it forward', async () => {
    const { validated } = await stage(
      'assets.csv',
      csv([
        ['Name', 'Date Purchased'],
        ['Bad date', '31/02/2026'],
      ]),
    );

    expect(validated!.body.data.counts.invalid).toBe(1);
  });

  it('flags duplicates within the file itself', async () => {
    const { id, validated } = await stage(
      'assets.csv',
      csv([
        ['Name', 'Serial'],
        ['First', 'SAME'],
        ['Second', 'SAME'],
      ]),
    );

    // Neither row exists in the database yet, so only a within-file check can
    // catch this.
    expect(validated!.body.data.counts.invalid).toBe(1);

    const rows = await as(request(server()).get(`/api/v1/imports/${id}/rows?status=invalid`));
    expect(rows.body.data[0].errors[0].message).toContain('Duplicate of row 2');
  });

  it('accumulates every problem in a row, not just the first', async () => {
    const { id } = await stage(
      'assets.csv',
      csv([
        ['Name', 'Date Purchased', 'Purchase Price', 'Condition'],
        ['', 'not-a-date', 'not-a-number', 'pristine'],
      ]),
    );

    const rows = await as(request(server()).get(`/api/v1/imports/${id}/rows?status=invalid`));

    // Someone fixing a spreadsheet wants every problem at once, not one per
    // upload.
    expect(rows.body.data[0].errors.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses the whole import if it would breach the plan', async () => {
    // Starter allows 250 assets. Checked at validation, so nothing is
    // half-imported (docs/06-edge-cases.md #38).
    const rows = [['Name', 'Serial'], ...Array.from({ length: 300 }, (_, i) => [`Asset ${i}`, `S${i}`])];
    const { validated } = await stage('big.csv', csv(rows));

    expect(validated!.status).toBe(402);
    expect(validated!.body.error.code).toBe('ENTITLEMENT_EXCEEDED');
  });
});

describe('duplicate strategies', () => {
  async function existingAsset(serial: string) {
    return as(
      request(server())
        .post('/api/v1/assets')
        .send({ name: 'Already here', assetTypeId: laptopTypeId, serialNumber: serial }),
    );
  }

  const file = csv([
    ['Name', 'Serial', 'Model'],
    ['Updated name', 'DUP-1', 'M3 Pro'],
  ]);

  it('errors on a duplicate by default', async () => {
    await existingAsset('DUP-1');
    const { validated } = await stage('a.csv', file, { duplicateStrategy: 'error' });

    expect(validated!.body.data.counts.invalid).toBe(1);
  });

  it('skips a duplicate when asked', async () => {
    await existingAsset('DUP-1');
    const { id, validated } = await stage('a.csv', file, { duplicateStrategy: 'skip' });

    expect(validated!.body.data.counts.duplicates).toBe(1);

    await as(request(server()).post(`/api/v1/imports/${id}/commit`));
    const job = await as(request(server()).get(`/api/v1/imports/${id}`));

    expect(job.body.data.counts.skipped).toBe(1);
    expect(job.body.data.counts.created).toBe(0);

    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data[0].name).toBe('Already here');
  });

  it('updates a duplicate when asked', async () => {
    await existingAsset('DUP-1');
    const { id } = await stage('a.csv', file, { duplicateStrategy: 'update' });

    await as(request(server()).post(`/api/v1/imports/${id}/commit`));
    const job = await as(request(server()).get(`/api/v1/imports/${id}`));

    expect(job.body.data.counts.updated).toBe(1);

    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data[0].name).toBe('Updated name');
    expect(assets.body.data[0].model).toBe('M3 Pro');
  });
});

describe('references', () => {
  const file = csv([
    ['Name', 'Serial', 'Department'],
    ['A laptop', 'S1', 'Engineering'],
  ]);

  it('rejects an unknown department by default', async () => {
    // Auto-creating from a typo-ridden spreadsheet produces "Fincance",
    // "finance " and "Finance" as three departments (docs/06-edge-cases.md #40).
    const { id } = await stage('a.csv', file);
    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    const job = await as(request(server()).get(`/api/v1/imports/${id}`));
    expect(job.body.data.counts.failed).toBe(1);

    const rows = await as(request(server()).get(`/api/v1/imports/${id}/rows?status=failed`));
    expect(rows.body.data[0].errors[0].message).toContain('Engineering');
  });

  it('creates a missing department when explicitly allowed', async () => {
    const { id } = await stage('a.csv', file, { createMissingReferences: true });
    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    const job = await as(request(server()).get(`/api/v1/imports/${id}`));
    expect(job.body.data.counts.created).toBe(1);

    const departments = await as(request(server()).get('/api/v1/departments'));
    expect(departments.body.data.map((d: { name: string }) => d.name)).toContain('Engineering');
  });
});

/**
 * The Milestone 5 gate.
 */
describe('the M5 gate: a deliberately messy spreadsheet', () => {
  it('imports the good rows, reports the bad ones, and commits cleanly', async () => {
    // Starter allows 250 assets. A real customer importing an estate this size
    // would be on a larger plan; raising the limit here uses the same
    // entitlement-override mechanism rather than bypassing the check.
    await raiseLimits(t.tenantId, { assets: 10_000 });

    const rows: string[][] = [['Asset Name', 'Serial No', 'Manufacturer', 'Date Purchased', 'Cost', 'Condition']];

    // 400 perfectly good rows.
    for (let i = 0; i < 400; i += 1) {
      rows.push([`Laptop ${i}`, `SN-${i}`, 'Apple', '14/03/2026', '1299.00', 'good']);
    }

    // …and a representative spread of the ways real files are broken.
    rows.push(['', 'SN-MISSING-NAME', 'Apple', '14/03/2026', '999', 'good']);
    rows.push(['Bad date', 'SN-BADDATE', 'Apple', '31/02/2026', '999', 'good']);
    rows.push(['US date', 'SN-USDATE', 'Apple', '03/25/2026', '999', 'good']);
    rows.push(['Bad money', 'SN-BADMONEY', 'Apple', '14/03/2026', 'about a grand', 'good']);
    rows.push(['Bad condition', 'SN-BADCOND', 'Apple', '14/03/2026', '999', 'pristine']);
    rows.push(['Dupe A', 'SN-DUPE', 'Apple', '14/03/2026', '999', 'good']);
    rows.push(['Dupe B', 'SN-DUPE', 'Apple', '14/03/2026', '999', 'good']);

    const { id, created, validated } = await stage('messy.csv', csv(rows), { dateFormat: 'DMY' });

    expect(created.body.data.counts.total).toBe(407);
    expect(validated!.status).toBe(200);

    const counts = validated!.body.data.counts;
    expect(counts.total).toBe(407);
    expect(counts.valid).toBe(401); // 400 good + the first of the duplicate pair
    expect(counts.invalid).toBe(6);

    // Every failure names the row and the reason, in the user's own numbering.
    const bad = await as(request(server()).get(`/api/v1/imports/${id}/rows?status=invalid`));
    const reasons = bad.body.data.map(
      (r: { rowNumber: number; errors: Array<{ message: string }> }) =>
        `${r.rowNumber}: ${r.errors.map((e) => e.message).join(' ')}`,
    );

    expect(reasons.some((r: string) => r.includes('Required'))).toBe(true);
    expect(reasons.some((r: string) => r.includes('not a date'))).toBe(true);
    expect(reasons.some((r: string) => r.includes('not an amount'))).toBe(true);
    expect(reasons.some((r: string) => r.includes('not a condition'))).toBe(true);
    expect(reasons.some((r: string) => r.includes('Duplicate of row'))).toBe(true);

    // A clean partial commit: the good rows land, the bad ones do not.
    const commit = await as(request(server()).post(`/api/v1/imports/${id}/commit`));
    expect(commit.status).toBe(202);
    expect(commit.body.data.statusUrl).toBe(`/api/v1/imports/${id}`);

    const job = await as(request(server()).get(`/api/v1/imports/${id}`));
    expect(job.body.data.status).toBe('completed');
    expect(job.body.data.counts.created).toBe(401);
    expect(job.body.data.counts.failed).toBe(0);
    expect(job.body.data.progress).toBe(100);

    const usage = await as(request(server()).get('/api/v1/tenant/usage'));
    expect(usage.body.data.usage.assets).toBe(401);

    // And a file of just the failures, to fix and re-upload.
    const errorFile = await as(request(server()).get(`/api/v1/imports/${id}/errors.csv`));
    expect(errorFile.status).toBe(200);
    expect(errorFile.headers['content-disposition']).toContain('attachment');

    const lines = errorFile.text.trim().split('\n');
    expect(lines).toHaveLength(7); // header + 6 failures
    // The original columns are preserved so the corrected file goes straight
    // back in with the same mapping.
    expect(lines[0]).toContain('Asset Name');
    expect(lines[0]).toContain('Problem');
  });
});

describe('commit idempotency', () => {
  it('does not duplicate anything when the commit runs twice', async () => {
    const { id } = await stage(
      'assets.csv',
      csv([
        ['Name', 'Serial'],
        ['One', 'S1'],
        ['Two', 'S2'],
      ]),
    );

    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    // A second commit finds no rows still awaiting one — which is what makes a
    // resumed or retried run safe.
    const second = await as(request(server()).post(`/api/v1/imports/${id}/commit`));
    expect(second.status).toBe(422);

    const assets = await as(request(server()).get('/api/v1/assets'));
    expect(assets.body.data).toHaveLength(2);
  });

  it('refuses to commit before validating', async () => {
    const created = await upload('assets.csv', csv([['Name'], ['A laptop']]));

    const res = await as(request(server()).post(`/api/v1/imports/${created.body.data.id}/commit`));
    expect(res.status).toBe(422);
  });
});

describe('imported records are ordinary records', () => {
  it('gets a generated tag, a timeline entry and an audit record', async () => {
    const { id } = await stage('assets.csv', csv([['Name', 'Serial'], ['Imported laptop', 'S1']]));
    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    const assets = await as(request(server()).get('/api/v1/assets'));
    const asset = assets.body.data[0];

    // Imports go through the same service as the API, so an imported record is
    // indistinguishable from a hand-created one.
    expect(asset.assetTag).toMatch(/^\w+-\d{4}$/);

    const timeline = await as(request(server()).get(`/api/v1/assets/${asset.id}/timeline`));
    expect(timeline.body.data[0].type).toBe('asset.created');

    const audit = await as(request(server()).get('/api/v1/audit-logs?entityType=asset'));
    expect(audit.body.data.map((a: { action: string }) => a.action)).toContain('asset.created');
  });
});

describe('exports', () => {
  it('exports assets as CSV with human-readable values', async () => {
    await as(
      request(server()).post('/api/v1/assets').send({
        name: 'Exportable',
        assetTypeId: laptopTypeId,
        serialNumber: 'EXP-1',
        purchase: { priceMinor: 129_900, currency: 'GBP' },
      }),
    ).expect(201);

    const res = await as(request(server()).get('/api/v1/exports/asset'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    // Major units, because that is what someone reading a spreadsheet expects.
    expect(res.text).toContain('1299.00');
    expect(res.text).toContain('Exportable');
  });

  it('neutralises formula injection on the way out', async () => {
    // The data is stored perfectly safely; it only becomes dangerous when a
    // spreadsheet opens it. Our export must not be the delivery mechanism.
    await as(
      request(server()).post('/api/v1/assets').send({
        name: '=cmd|\'/c calc\'!A1',
        assetTypeId: laptopTypeId,
        serialNumber: 'INJ-1',
      }),
    ).expect(201);

    const res = await as(request(server()).get('/api/v1/exports/asset'));

    expect(res.text).toContain("'=cmd");
    // The raw formula must never appear at the start of a cell.
    expect(res.text).not.toMatch(/(^|,)"?=cmd/);
  });

  it('includes tenant-defined columns automatically', async () => {
    await as(
      request(server()).post('/api/v1/catalog/custom-fields').send({
        appliesTo: 'asset',
        label: 'RAM (GB)',
        type: 'number',
      }),
    ).expect(201);

    await as(
      request(server()).post('/api/v1/assets').send({
        name: 'With RAM',
        assetTypeId: laptopTypeId,
        serialNumber: 'RAM-1',
        customFields: { ram_gb: 36 },
      }),
    ).expect(201);

    const res = await as(request(server()).get('/api/v1/exports/asset'));

    expect(res.text).toContain('RAM (GB)');
    expect(res.text).toContain('36');
  });

  it('fails a row that omits a serial the asset type requires', async () => {
    // Import goes through the same service as the API, so the type's own rules
    // apply — and the failure is reported per row rather than aborting the run.
    const { id } = await stage('assets.csv', csv([['Name'], ['No serial here']]));
    await as(request(server()).post(`/api/v1/imports/${id}/commit`));

    const rows = await as(request(server()).get(`/api/v1/imports/${id}/rows?status=failed`));
    expect(rows.body.data[0].errors[0].message).toContain('serial number');
  });

  it('refuses an asset import that does not say what it is importing', async () => {
    // Otherwise five thousand laptops silently become accessories.
    const res = await as(
      request(server())
        .post('/api/v1/imports?entityType=asset&fileName=assets.csv')
        .set('Content-Type', 'text/csv')
        .send(csv([['Name'], ['A laptop']])),
    );

    expect(res.status).toBe(422);
    expect(res.body.error.fields.assetTypeId).toBeDefined();
  });

  it('offers a template with the right headings and a worked example', async () => {
    const res = await as(request(server()).get('/api/v1/imports/templates/asset'));

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');

    expect(lines[0]).toContain('Serial number');
    // An example row, because a blank template leaves people guessing at the
    // date format.
    expect(lines[1]).toContain('MacBook Pro 14');
  });

  it('round-trips: export, then import the same file back', async () => {
    await as(
      request(server()).post('/api/v1/assets').send({
        name: 'Round trip',
        assetTypeId: laptopTypeId,
        serialNumber: 'RT-1',
        brand: 'Apple',
      }),
    ).expect(201);

    const exported = await as(request(server()).get('/api/v1/exports/asset'));

    // Skip is the honest strategy here: everything in the file already exists.
    const { validated } = await stage('round-trip.csv', exported.text, {
      duplicateStrategy: 'skip',
      dateFormat: 'ISO',
    });

    expect(validated!.body.data.counts.invalid).toBe(0);
    expect(validated!.body.data.counts.duplicates).toBe(1);
  });
});
