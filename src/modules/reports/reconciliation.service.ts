import { logger } from '../../core/logging/index.js';
import { runAsSystem, withoutTenantScope } from '../../core/context/index.js';
import { ulid } from 'ulid';
import { metrics } from '../../core/telemetry/index.js';
import { TenantModel } from '../tenants/index.js';
import { AssetModel } from '../assets/index.js';
import { AssignmentModel } from '../assignments/index.js';
import { TenantUsageModel } from '../subscriptions/index.js';
import { PersonModel } from '../people/index.js';

/**
 * Checks that denormalised data still agrees with its source.
 *
 * `asset.currentAssignment` is a cache. It is written only by the assignment
 * service, inside the same transaction as the Assignment record — so in theory
 * it cannot drift. In practice caches drift: a migration writes around the
 * service, a bug slips past review, a partial restore lands.
 *
 * Every denormalised field needs a job like this. It is the price of
 * denormalising, and it is the step teams skip — which is why the drift is
 * always discovered by a customer rather than by us.
 *
 * Reports by default. Repairs only when asked, and every repair is logged.
 */

export interface Discrepancy {
  kind:
    | 'assignment_missing_from_asset'
    | 'asset_points_at_nothing'
    | 'asset_points_at_wrong_assignment'
    | 'usage_count_wrong';
  assetId?: string;
  assignmentId?: string;
  detail: string;
  repaired: boolean;
}

export interface ReconciliationReport {
  tenantId: string;
  checked: { assets: number; assignments: number };
  discrepancies: Discrepancy[];
  repaired: number;
}

/**
 * Reconciles one tenant.
 *
 * Both directions matter and they fail differently:
 *
 *   an ACTIVE assignment the asset does not point at → the asset looks free,
 *   and someone will assign it to a second person;
 *
 *   an asset pointing at a returned or missing assignment → the asset looks
 *   held, and nobody can assign it at all.
 */
export async function reconcileTenant(
  tenantId: string,
  options: { repair?: boolean } = {},
): Promise<ReconciliationReport> {
  const repair = options.repair ?? false;
  const discrepancies: Discrepancy[] = [];

  const activeAssignments = await AssignmentModel.find({ status: 'active' })
    .select('assetId assigneeId assigneeType assignedAt')
    .lean();

  const activeByAsset = new Map(activeAssignments.map((a) => [String(a.assetId), a]));

  const assets = await AssetModel.find({})
    .select('currentAssignment lifecycleState assetTag')
    .lean();

  const seenAssets = new Set<string>();

  for (const asset of assets) {
    const assetId = String(asset._id);
    seenAssets.add(assetId);

    const active = activeByAsset.get(assetId);
    const cached = asset.currentAssignment;

    if (active && !cached) {
      discrepancies.push({
        kind: 'assignment_missing_from_asset',
        assetId,
        assignmentId: String(active._id),
        // The dangerous direction: the asset looks free and will be
        // double-assigned.
        detail: `${asset.assetTag} is assigned but shows as unassigned.`,
        repaired: repair,
      });

      if (repair) {
        await AssetModel.updateOne(
          { _id: assetId },
          {
            $set: {
              currentAssignment: {
                assignmentId: String(active._id),
                assigneeType: active.assigneeType,
                assigneeId: active.assigneeId,
                assignedAt: active.assignedAt,
              },
            },
          },
        );
      }
      continue;
    }

    if (!active && cached) {
      discrepancies.push({
        kind: 'asset_points_at_nothing',
        assetId,
        assignmentId: cached.assignmentId ?? undefined,
        detail: `${asset.assetTag} shows as assigned but has no active assignment.`,
        repaired: repair,
      });

      if (repair) {
        await AssetModel.updateOne({ _id: assetId }, { $set: { currentAssignment: null } });
      }
      continue;
    }

    if (active && cached && cached.assignmentId !== String(active._id)) {
      discrepancies.push({
        kind: 'asset_points_at_wrong_assignment',
        assetId,
        assignmentId: String(active._id),
        detail: `${asset.assetTag} points at a different assignment than the active one.`,
        repaired: repair,
      });

      if (repair) {
        await AssetModel.updateOne(
          { _id: assetId },
          {
            $set: {
              currentAssignment: {
                assignmentId: String(active._id),
                assigneeType: active.assigneeType,
                assigneeId: active.assigneeId,
                assignedAt: active.assignedAt,
              },
            },
          },
        );
      }
    }
  }

  /**
   * Usage counters drive plan enforcement, so drift here either blocks a
   * customer who is within their limit or lets one past it. Both are worth
   * catching before they are reported to us.
   */
  const [assetCount, peopleCount] = await Promise.all([
    AssetModel.countDocuments({}),
    PersonModel.countDocuments({ status: { $ne: 'inactive' } }),
  ]);

  const usage = await TenantUsageModel.findOne({}).lean();

  if (usage && usage.assetCount !== assetCount) {
    discrepancies.push({
      kind: 'usage_count_wrong',
      detail: `Asset count says ${usage.assetCount}, actual is ${assetCount}.`,
      repaired: repair,
    });
    if (repair) await TenantUsageModel.updateOne({}, { $set: { assetCount } });
  }

  if (usage && usage.peopleCount !== peopleCount) {
    discrepancies.push({
      kind: 'usage_count_wrong',
      detail: `People count says ${usage.peopleCount}, actual is ${peopleCount}.`,
      repaired: repair,
    });
    if (repair) await TenantUsageModel.updateOne({}, { $set: { peopleCount } });
  }

  if (repair && usage) {
    await TenantUsageModel.updateOne({}, { $set: { lastRecalculatedAt: new Date() } });
  }

  return {
    tenantId,
    checked: { assets: assets.length, assignments: activeAssignments.length },
    discrepancies,
    repaired: repair ? discrepancies.length : 0,
  };
}

/**
 * Reconciles every active tenant.
 *
 * Repairs by default when run as a job: the failure modes above are worse than
 * the repair, and a discrepancy that is only ever reported is one nobody fixes.
 * Every repair is logged and counted, so a rising count is a signal that
 * something upstream is writing around the assignment service.
 */
export async function reconcileAll(options: { repair?: boolean } = {}): Promise<{
  tenants: number;
  discrepancies: number;
  repaired: number;
}> {
  const repair = options.repair ?? true;

  const tenants = await runAsSystem({ requestId: ulid() }, () =>
    withoutTenantScope('nightly reconciliation across every tenant', () =>
      TenantModel.find({ status: { $in: ['active', 'trialing'] } })
        .select('_id')
        .lean(),
    ),
  );

  let discrepancies = 0;
  let repaired = 0;

  for (const tenant of tenants) {
    const tenantId = String(tenant._id);

    try {
      const report = await runAsSystem(
        { requestId: ulid(), tenantId, actorType: 'job' },
        () => reconcileTenant(tenantId, { repair }),
      );

      discrepancies += report.discrepancies.length;
      repaired += report.repaired;

      if (report.discrepancies.length > 0) {
        // Loud on purpose. Drift means something wrote around the assignment
        // service, and the repair treats the symptom.
        logger.error(
          { tenantId, discrepancies: report.discrepancies },
          'Reconciliation found drift between an asset and its assignments',
        );
      }
    } catch (err) {
      // One tenant's failure must not stop the sweep for everyone else.
      logger.error({ err, tenantId }, 'Reconciliation failed for a tenant');
    }
  }

  metrics.increment('reconciliation_discrepancies', discrepancies);

  logger.info({ tenants: tenants.length, discrepancies, repaired }, 'Reconciliation complete');

  return { tenants: tenants.length, discrepancies, repaired };
}
