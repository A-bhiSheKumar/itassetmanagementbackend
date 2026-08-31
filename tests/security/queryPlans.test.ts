import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { useTestServer } from '../helpers/testServer.js';
import { useSharedFixtures } from '../setup.js';
import { ensurePlansSeeded, seedTenant, type SeededTenant } from '../helpers/factories.js';
import { runAsSystem } from '../../src/core/context/index.js';
import { AssetModel } from '../../src/modules/assets/index.js';
import { PersonModel } from '../../src/modules/people/index.js';
import { AssignmentModel } from '../../src/modules/assignments/index.js';
import { AuditLogModel } from '../../src/modules/auditlog/index.js';
import { AssetEventModel } from '../../src/modules/timeline/index.js';

/**
 * The plan is the proof, not the index definition.
 *
 * An index that exists but is not CHOSEN buys nothing, and the two come apart
 * easily: a field order that violates ESR, a filter shape the planner cannot
 * use, a partial index whose filter does not match the query. Declaring an
 * index and assuming it works is how a list endpoint is fast on a developer's
 * hundred rows and unusable on a customer's hundred thousand.
 *
 * These run explain() against the real planner and fail on a collection scan.
 */

const app = createApp();
const server = useTestServer(app);

let t: SeededTenant;

useSharedFixtures();

beforeAll(async () => {
  await ensurePlansSeeded();
  t = await seedTenant(server(), 'plans');

  await runAsSystem({ requestId: 'plan-setup', tenantId: t.tenantId }, async () => {
    // Indexes are built in the background by default. explain() against a
    // collection whose indexes have not finished building reports a scan, and
    // the test would lie. syncIndexes() also THROWS on a malformed index rather
    // than swallowing it, which is how the invalid warranty partial filter was
    // found.
    for (const model of [AssetModel, PersonModel, AssignmentModel, AuditLogModel, AssetEventModel]) {
      await model.syncIndexes();
    }

    /**
     * Enough rows for the planner to have something to reason about.
     *
     * On an empty collection every plan costs nothing, so the winning plan is
     * close to arbitrary and an assertion about WHICH index was chosen proves
     * nothing.
     */
    await AssetModel.insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        assetTag: `PLAN-${String(i).padStart(4, '0')}`,
        name: `Planning asset ${i}`,
        assetTypeId: '000000000000000000000000',
        lifecycleState: i % 3 === 0 ? 'deployed' : 'in_stock',
        serialNumber: `PLAN-SN-${i}`,
        searchTokens: [`planning`, `asset${i}`],
        warranty: { expiresAt: new Date(Date.now() + i * 86_400_000) },
        cf: { s: {}, n: { ram_gb: 8 + (i % 4) * 8 }, d: {}, b: {}, r: {}, m: {} },
      })) as never,
    );
  });
}, 120_000);

type Stage = { stage?: string; inputStage?: Stage; inputStages?: Stage[] };

/** Every stage name in the winning plan, flattened. */
function stages(plan: Stage): string[] {
  const found: string[] = [];
  const walk = (node: Stage | undefined): void => {
    if (!node) return;
    if (node.stage) found.push(node.stage);
    walk(node.inputStage);
    for (const child of node.inputStages ?? []) walk(child);
  };
  walk(plan);
  return found;
}

interface PlanResult {
  stages: string[];
  indexName: string | null;
  usesIndex: boolean;
  /** Every index the planner CONSIDERED, winning plan included. */
  candidateIndexes: string[];
}

async function explain(
  model: mongoose.Model<never>,
  filter: Record<string, unknown>,
  sort?: Record<string, 1 | -1>,
): Promise<PlanResult> {
  return runAsSystem({ requestId: 'explain', tenantId: t.tenantId }, async () => {
    const query = model.find(filter as never);
    if (sort) query.sort(sort);

    const result = (await query.explain('queryPlanner')) as unknown as {
      queryPlanner: {
        winningPlan: Stage & { inputStage?: Stage & { indexName?: string } };
        rejectedPlans?: Array<Stage & { indexName?: string }>;
      };
    };

    const plan = result.queryPlanner.winningPlan;
    const names = stages(plan);

    // The index name lives at whichever depth the IXSCAN sits.
    let indexName: string | null = null;
    const findIndex = (node: (Stage & { indexName?: string }) | undefined): void => {
      if (!node) return;
      if (node.stage === 'IXSCAN' && node.indexName) indexName = node.indexName;
      findIndex(node.inputStage as never);
      for (const child of node.inputStages ?? []) findIndex(child as never);
    };
    findIndex(plan);

    // Every index the planner was willing to consider.
    const candidateIndexes: string[] = [];
    const collectIndexes = (node: (Stage & { indexName?: string }) | undefined): void => {
      if (!node) return;
      if (node.indexName) candidateIndexes.push(node.indexName);
      collectIndexes(node.inputStage as never);
      for (const child of node.inputStages ?? []) collectIndexes(child as never);
    };
    collectIndexes(plan);
    for (const rejected of result.queryPlanner.rejectedPlans ?? []) collectIndexes(rejected);

    return {
      stages: names,
      indexName,
      usesIndex: names.includes('IXSCAN'),
      candidateIndexes,
    };
  });
}

function expectIndexed(result: PlanResult, label: string): void {
  expect(
    result.usesIndex,
    `${label} is a COLLECTION SCAN (${result.stages.join(' → ')}). It is fine on a ` +
      'developer machine and unusable at a hundred thousand rows.',
  ).toBe(true);
}

describe('asset queries use an index', () => {
  it('the default list view', async () => {
    // The most-hit query in the product.
    const plan = await explain(
      AssetModel as never,
      { deletedAt: null, lifecycleState: 'in_stock' },
      { updatedAt: -1 },
    );

    expectIndexed(plan, 'The asset list');
  });

  it('filtering by asset type', async () => {
    expectIndexed(
      await explain(AssetModel as never, { assetTypeId: '000000000000000000000000', deletedAt: null }),
      'Filtering assets by type',
    );
  });

  it('filtering by location', async () => {
    expectIndexed(
      await explain(AssetModel as never, { 'placement.locationId': '000000000000000000000000' }),
      'Filtering assets by location',
    );
  });

  it('finding what a person holds', async () => {
    // The offboarding screen and an employee's own view.
    expectIndexed(
      await explain(AssetModel as never, {
        'currentAssignment.assigneeId': '000000000000000000000000',
      }),
      'Finding what a person holds',
    );
  });

  it('the warranty expiry scan', async () => {
    // Runs nightly for every tenant. A scan here is a scan per customer.
    expectIndexed(
      // The exact shape the service issues. `$type` is load-bearing: a partial
      // index is only used when the query provably implies its filter.
      await explain(AssetModel as never, {
        'warranty.expiresAt': { $type: 'date', $lte: new Date() },
        lifecycleState: { $nin: ['disposed', 'lost', 'retired'] },
      }),
      'The warranty scan',
    );
  });

  it('lookup by serial number', async () => {
    // Every import row runs this to detect duplicates.
    expectIndexed(
      await explain(AssetModel as never, { serialNumber: 'SN-1' }),
      'Serial number lookup',
    );
  });

  it('lookup by asset tag', async () => {
    expectIndexed(await explain(AssetModel as never, { assetTag: 'LAP-0001' }), 'Asset tag lookup');
  });

  it('cursor pagination', async () => {
    const plan = await explain(
      AssetModel as never,
      { deletedAt: null, createdAt: { $lt: new Date() } },
      { createdAt: -1, _id: -1 },
    );

    expectIndexed(plan, 'Cursor pagination');
  });

  it('filtering on a custom field', async () => {
    // The compound wildcard index. Without it, every tenant-defined filter is a
    // full scan — which would make the whole dynamic field system unusable.
    // The soft-delete plugin adds `deletedAt: null`, so this is the query shape
    // the application actually issues.
    const plan = await explain(AssetModel as never, { 'cf.n.ram_gb': { $gte: 16 } });

    expectIndexed(plan, 'Filtering on a custom field');

    /**
     * The assertion is that the wildcard index is USABLE, not that it wins.
     *
     * Which plan wins depends on selectivity and collection size, and at a few
     * hundred rows every plan is cheap enough that the choice is close to
     * arbitrary. What matters — and what silently breaks — is whether the
     * planner can use the index at all: an index it cannot use for this query
     * shape is an index that does nothing, however large the collection gets.
     */
    expect(
      plan.candidateIndexes.some((name) => name.includes('$**')),
      `The planner did not consider the wildcard index for a custom-field filter. ` +
        `It looked at: ${plan.candidateIndexes.join(', ') || 'nothing'}. Without it, every ` +
        'tenant-defined filter is a collection scan at size.',
    ).toBe(true);
  });

  it('counting by condition, for the dashboard', async () => {
    // The attention panel counts these live on every dashboard load.
    expectIndexed(
      await explain(AssetModel as never, {
        condition: 'damaged',
        lifecycleState: { $nin: ['disposed', 'retired'] },
      }),
      'Counting damaged assets',
    );
  });

  it('quick search by token', async () => {
    expectIndexed(
      await explain(AssetModel as never, { searchTokens: /^macbook/ }),
      'Asset quick search',
    );
  });
});

describe('people queries use an index', () => {
  it('the default list view', async () => {
    expectIndexed(
      await explain(PersonModel as never, { status: 'active', deletedAt: null }, { lastName: 1 }),
      'The people list',
    );
  });

  it('lookup by email', async () => {
    expectIndexed(await explain(PersonModel as never, { email: 'a@b.test' }), 'Person email lookup');
  });

  it('finding direct reports', async () => {
    expectIndexed(
      await explain(PersonModel as never, { managerId: '000000000000000000000000' }),
      'Direct reports',
    );
  });

  it('directory sync correlation', async () => {
    expectIndexed(
      await explain(PersonModel as never, {
        'externalRefs.system': 'entra',
        'externalRefs.id': 'abc',
      }),
      'Directory sync correlation',
    );
  });
});

describe('assignment queries use an index', () => {
  it('the active assignment for an asset', async () => {
    // Checked on every assign, return and transfer.
    expectIndexed(
      await explain(AssignmentModel as never, { assetId: '000000000000000000000000', status: 'active' }),
      'The active assignment lookup',
    );
  });

  it('everything a person holds', async () => {
    expectIndexed(
      await explain(AssignmentModel as never, {
        assigneeId: '000000000000000000000000',
        status: 'active',
      }),
      'Active assignments for a person',
    );
  });

  it('chain of custody for an asset', async () => {
    expectIndexed(
      await explain(
        AssignmentModel as never,
        { assetId: '000000000000000000000000' },
        { assignedAt: -1 },
      ),
      'Chain of custody',
    );
  });
});

describe('history queries use an index', () => {
  it('the asset timeline', async () => {
    expectIndexed(
      await explain(
        AssetEventModel as never,
        { assetId: '000000000000000000000000' },
        { occurredAt: -1 },
      ),
      'The asset timeline',
    );
  });

  it('the audit browser', async () => {
    expectIndexed(
      await explain(AuditLogModel as never, {}, { occurredAt: -1 }),
      'The audit log browser',
    );
  });

  it('audit history for one record', async () => {
    expectIndexed(
      await explain(AuditLogModel as never, {
        entityType: 'asset',
        entityId: '000000000000000000000000',
      }),
      'Audit history for a record',
    );
  });

  it('denied authorisation attempts', async () => {
    // A burst of these is the clearest signal of an attack in progress, so the
    // query that surfaces them must stay fast.
    expectIndexed(
      await explain(AuditLogModel as never, { outcome: 'denied' }, { occurredAt: -1 }),
      'Denied attempts',
    );
  });
});

describe('every index leads with tenantId', () => {
  it('so the planner can use it for a tenant-scoped query', async () => {
    // Layer two of the argument: the tenant filter is injected into EVERY
    // query, so an index that does not lead with tenantId cannot serve one.
    const models = [AssetModel, PersonModel, AssignmentModel, AuditLogModel, AssetEventModel];

    for (const model of models) {
      const indexes = await model.collection.indexes();

      for (const index of indexes) {
        if (index.name === '_id_') continue;

        /**
         * A TTL index must be single-field on the date it expires by — MongoDB
         * refuses a compound one. It is not a query index, so it never needs to
         * serve a tenant-scoped filter.
         */
        if (index.expireAfterSeconds !== undefined) continue;

        const first = Object.keys(index.key)[0];
        expect(
          first,
          `${model.modelName}.${index.name} starts with "${first}". A tenant-scoped ` +
            'query filters on tenantId first, so this index can never serve one.',
        ).toBe('tenantId');
      }
    }
  });
});
