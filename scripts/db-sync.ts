/**
 * Prepares a database for the code about to be deployed.
 *
 *     npm run db:sync              # build missing indexes, seed plans, check the cluster
 *     npm run db:sync -- --prune   # also drop indexes the schemas no longer define
 *
 * A deploy step, not a startup step. Production connects with `autoIndex` off,
 * because building indexes on a cold start slows whichever request woke the
 * container and a failure there is only a log line. Here a failure exits
 * non-zero, so a deploy with a broken index stops instead of shipping queries
 * that silently scan a whole collection.
 *
 * Pruning is opt-in. Dropping an index the schema does not mention is usually
 * cleanup, but it can also remove one somebody added by hand during an incident
 * — which should be a decision, not a side effect of deploying.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, assertTransactionsSupported } from '../src/core/db/index.js';
// Importing the router compiles every model, so none is missed.
import '../src/routes.js';
import '../src/core/jobs/index.js';
import '../src/core/locks/index.js';
import '../src/core/http/index.js';
import { seedPlans } from '../src/modules/subscriptions/index.js';
import { syncSystemRolePermissions } from '../src/modules/roles/index.js';
import { TenantModel } from '../src/modules/tenants/index.js';
import { runAsSystem, withoutTenantScope } from '../src/core/context/index.js';

const prune = process.argv.includes('--prune');

async function main(): Promise<void> {
  await connectDatabase();
  await assertTransactionsSupported();
  console.log(`Connected to ${mongoose.connection.name}; transactions supported.`);

  let failures = 0;

  for (const model of Object.values(mongoose.models).sort((a, b) => a.modelName.localeCompare(b.modelName))) {
    try {
      const diff = await model.diffIndexes();
      await model.createIndexes();

      const created = diff.toCreate.length;
      const stale = diff.toDrop;

      if (prune && stale.length > 0) {
        for (const name of stale) await model.collection.dropIndex(name);
      }

      if (created > 0 || stale.length > 0) {
        console.log(
          `  ${model.modelName.padEnd(24)} +${created} created` +
            (stale.length > 0 ? `, ${stale.length} ${prune ? 'dropped' : 'not in schema (use --prune)'}: ${stale.join(', ')}` : ''),
        );
      }
    } catch (err) {
      failures += 1;
      console.error(`  ${model.modelName.padEnd(24)} FAILED: ${(err as Error).message}`);
    }
  }

  await seedPlans();
  console.log('Plans seeded.');

  // Permissions added in this release reach organisations created before it.
  const tenants = await runAsSystem({ requestId: 'db-sync' }, () =>
    withoutTenantScope('db-sync: role permissions', () => TenantModel.find({}).select('_id name').lean()),
  );
  let updated = 0;
  for (const tenant of tenants) {
    const changed = await runAsSystem({ requestId: 'db-sync', tenantId: String(tenant._id) }, () => syncSystemRolePermissions());
    if (changed.length > 0) updated += 1;
  }
  console.log(`System roles checked in ${tenants.length} organisation(s); ${updated} updated.`);

  await disconnectDatabase();

  if (failures > 0) {
    console.error(`\n${failures} model(s) failed to sync. Fix before deploying.`);
    process.exit(1);
  }

  console.log('Database ready.');
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
