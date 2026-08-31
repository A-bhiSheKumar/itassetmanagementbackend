/* eslint-disable no-console */
/**
 * Load test: does the API stay fast at a hundred thousand assets?
 *
 *   npm run loadtest              # 100,000 assets, the M6 gate
 *   ASSETS=10000 npm run loadtest # quicker smoke run
 *
 * Seeds directly through the models rather than the API. Going through the HTTP
 * layer would measure how fast we can create a hundred thousand assets, which
 * is not the question — the question is how the READ paths behave once the data
 * is there.
 *
 * Runs against whatever MONGO_URI points at. With none set it starts a
 * throwaway in-memory replica set, so this is runnable without any setup.
 */
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ulid } from 'ulid';

const TARGET_ASSETS = Number(process.env.ASSETS ?? 100_000);
const SAMPLES = Number(process.env.SAMPLES ?? 40);
const BATCH = 2_000;

/** The gate: p95 under 300 ms on the core read paths. */
const P95_BUDGET_MS = 300;

let replSet: MongoMemoryReplSet | undefined;

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) {
    console.log('No MONGO_URI — starting a throwaway replica set…');
    replSet = await MongoMemoryReplSet.create({
      instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '1'] }],
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGO_URI = replSet.getUri();
  }

  process.env.NODE_ENV ??= 'development';
  process.env.LOG_LEVEL ??= 'error';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6399';
  process.env.JWT_ACCESS_SECRET ??= 'loadtest-access-secret-at-least-32-characters';
  process.env.JWT_REFRESH_SECRET ??= 'loadtest-refresh-secret-at-least-32-characters';

  const { connectDatabase, disconnectDatabase } = await import('../src/core/db/index.js');
  const { runAsSystem } = await import('../src/core/context/index.js');
  const { AssetModel, listAssets } = await import('../src/modules/assets/index.js');
  const { PersonModel } = await import('../src/modules/people/index.js');
  const { rebuildDailyMetrics, currentMetrics, needsAttention } = await import(
    '../src/modules/reports/index.js'
  );

  await connectDatabase();

  const tenantId = `load_${ulid()}`;
  const otherTenantId = `noise_${ulid()}`;

  await runAsSystem({ requestId: 'loadtest', tenantId }, async () => {
    console.log(`\nBuilding indexes…`);
    await AssetModel.syncIndexes();
    await PersonModel.syncIndexes();

    console.log(`Seeding ${TARGET_ASSETS.toLocaleString()} assets…`);
    const started = performance.now();

    for (let offset = 0; offset < TARGET_ASSETS; offset += BATCH) {
      const size = Math.min(BATCH, TARGET_ASSETS - offset);

      await AssetModel.collection.insertMany(
        Array.from({ length: size }, (_, i) => {
          const n = offset + i;
          return {
            // Written through the raw collection: the point is the read paths,
            // and going through the service would take hours.
            tenantId,
            assetTag: `LAP-${String(n).padStart(7, '0')}`,
            name: `Laptop ${n}`,
            assetTypeId: '000000000000000000000000',
            lifecycleState: n % 4 === 0 ? 'deployed' : 'in_stock',
            condition: n % 50 === 0 ? 'damaged' : 'good',
            serialNumber: `SN-${n}`,
            model: n % 2 === 0 ? 'M3 Pro' : 'M2 Air',
            brand: 'Apple',
            searchTokens: [`laptop`, `laptop${n}`, `sn`, `sn-${n}`],
            purchase: { priceMinor: 129_900 + (n % 500) * 100, currency: 'GBP' },
            warranty: { expiresAt: new Date(Date.now() + ((n % 400) - 30) * 86_400_000) },
            placement: { locationId: `loc_${n % 20}`, departmentId: `dep_${n % 12}` },
            currentAssignment:
              n % 4 === 0
                ? { assignmentId: `asg_${n}`, assigneeType: 'person', assigneeId: `per_${n % 5_000}`, assignedAt: new Date() }
                : null,
            cf: { s: {}, n: { ram_gb: [8, 16, 32, 64][n % 4] }, d: {}, b: {}, r: {}, m: {} },
            deletedAt: null,
            createdAt: new Date(Date.now() - n * 1_000),
            updatedAt: new Date(Date.now() - n * 1_000),
            __v: 0,
          };
        }),
        { ordered: false },
      );

      if ((offset / BATCH) % 10 === 0) {
        process.stdout.write(`  ${Math.round(((offset + size) / TARGET_ASSETS) * 100)}%\r`);
      }
    }

    /**
     * A second tenant's data, so every measurement below includes the cost of
     * filtering it out. Benchmarking a single-tenant collection would flatter
     * the numbers and prove nothing about the isolation model.
     */
    await AssetModel.collection.insertMany(
      Array.from({ length: Math.min(20_000, TARGET_ASSETS) }, (_, i) => ({
        tenantId: otherTenantId,
        assetTag: `OTH-${i}`,
        name: `Other tenant ${i}`,
        assetTypeId: '000000000000000000000000',
        lifecycleState: 'in_stock',
        condition: 'good',
        serialNumber: `OTH-SN-${i}`,
        searchTokens: ['other'],
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      })),
      { ordered: false },
    );

    const total = await AssetModel.collection.countDocuments({});
    console.log(
      `  seeded in ${((performance.now() - started) / 1000).toFixed(1)}s — ` +
        `${total.toLocaleString()} documents in the collection\n`,
    );
  });

  const results: Array<{ name: string; p50: number; p95: number; p99: number; max: number }> = [];

  async function measure(name: string, work: () => Promise<unknown>): Promise<void> {
    // One untimed run so the first measurement is not paying for a cold cache.
    await runAsSystem({ requestId: 'warm', tenantId }, work);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      await runAsSystem({ requestId: `s${i}`, tenantId }, work);
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!;

    results.push({
      name,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: samples[samples.length - 1]!,
    });
  }

  console.log('Measuring…\n');

  await measure('asset list (first page)', () => listAssets({ filters: {}, limit: 50 }));

  await measure('asset list (filtered by state)', () =>
    listAssets({ filters: { lifecycleState: 'in_stock' }, limit: 50 }),
  );

  await measure('asset list (filtered by location)', () =>
    listAssets({ filters: { locationId: 'loc_7' }, limit: 50 }),
  );

  await measure('asset list (unassigned only)', () =>
    listAssets({ filters: { unassigned: true }, limit: 50 }),
  );

  await measure('custom field filter (ram >= 32)', () =>
    listAssets({ filters: { customFilters: { 'cf.n.ram_gb': { $gte: 32 } } }, limit: 50 }),
  );

  await measure('quick search by prefix', () => listAssets({ filters: { q: 'laptop9' }, limit: 50 }));

  await measure('what one person holds', () =>
    listAssets({ filters: { assigneeId: 'per_42' }, limit: 50 }),
  );

  await measure('serial number lookup', () =>
    AssetModel.findOne({ serialNumber: `SN-${Math.floor(TARGET_ASSETS / 2)}` }).lean(),
  );

  // Deep pagination: the reason cursors exist. An offset here would make Mongo
  // walk every skipped document.
  let cursor: string | null = null;
  await runAsSystem({ requestId: 'seek', tenantId }, async () => {
    for (let page = 0; page < 20; page += 1) {
      const result = await listAssets({ filters: {}, limit: 50, cursor: cursor ?? undefined });
      cursor = result.cursor;
      if (!cursor) break;
    }
  });
  const deepCursor = cursor;

  await measure('page 20 via cursor', () =>
    listAssets({ filters: {}, limit: 50, cursor: deepCursor ?? undefined }),
  );

  await runAsSystem({ requestId: 'rollup', tenantId }, () => rebuildDailyMetrics());

  await measure('dashboard (from the rollup)', async () => {
    await currentMetrics();
    await needsAttention();
  });

  await measure('metrics rollup rebuild', () => rebuildDailyMetrics());

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(
    `${'operation'.padEnd(36)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}`,
  );
  console.log('─'.repeat(72));

  let failures = 0;

  for (const r of results) {
    // The rollup is a nightly job, not a request path, so the budget does not
    // apply to it — but it is worth seeing.
    const exempt = r.name === 'metrics rollup rebuild';
    const over = !exempt && r.p95 > P95_BUDGET_MS;
    if (over) failures += 1;

    console.log(
      `${r.name.padEnd(36)}${r.p50.toFixed(1).padStart(9)}${r.p95.toFixed(1).padStart(9)}` +
        `${r.p99.toFixed(1).padStart(9)}${r.max.toFixed(1).padStart(9)}` +
        (over ? '   OVER BUDGET' : exempt ? '   (job, exempt)' : ''),
    );
  }

  console.log('─'.repeat(72));
  console.log(
    `\n${TARGET_ASSETS.toLocaleString()} assets · budget p95 < ${P95_BUDGET_MS}ms · ` +
      `${failures === 0 ? 'PASS' : `${failures} OVER BUDGET`}\n`,
  );

  await disconnectDatabase();
  await replSet?.stop();

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await replSet?.stop();
  process.exit(1);
});
