import { logger } from '../../core/logging/index.js';
import { runAsSystem, withoutTenantScope } from '../../core/context/index.js';
import { ulid } from 'ulid';
import { TenantModel } from '../tenants/index.js';
import { MembershipModel } from '../memberships/index.js';
import { UserModel } from '../identity/index.js';
import { notify } from '../notifications/index.js';
import { sweepAbandonedUploads } from '../documents/index.js';
import { warrantyPipeline } from './attention.service.js';
import { rebuildDailyMetrics } from './metrics.service.js';

/**
 * Scheduled work.
 *
 * Every scan iterates tenants in batches and runs each under ITS OWN context,
 * so the tenant-scope plugin applies to a background job exactly as it does to
 * a request. A job that could read across tenants would defeat the whole
 * isolation model.
 *
 * Batching per tenant also means one enormous customer cannot starve the rest —
 * a single global scan over every asset would.
 */

const NOTICE_THRESHOLDS = [30, 7];

async function eachActiveTenant(
  label: string,
  work: (tenantId: string) => Promise<void>,
): Promise<{ tenants: number; failures: number }> {
  const tenants = await runAsSystem({ requestId: ulid() }, () =>
    withoutTenantScope(`scheduled scan: ${label}`, () =>
      TenantModel.find({ status: { $in: ['active', 'trialing'] } })
        .select('_id')
        .lean(),
    ),
  );

  let failures = 0;

  for (const tenant of tenants) {
    const tenantId = String(tenant._id);

    try {
      await runAsSystem({ requestId: ulid(), tenantId, actorType: 'job' }, () => work(tenantId));
    } catch (err) {
      // One tenant's failure must not stop the scan for everyone else.
      failures += 1;
      logger.error({ err, tenantId, scan: label }, 'Scan failed for a tenant');
    }
  }

  return { tenants: tenants.length, failures };
}

/**
 * Warns about warranties about to lapse.
 *
 * Notifies at 30 and 7 days. The dedupe key includes the threshold, so a
 * nightly run sends each notice once rather than every night for a month.
 */
export async function scanExpiringWarranties(): Promise<{ tenants: number; notices: number }> {
  let notices = 0;

  const result = await eachActiveTenant('warranty-expiry', async (tenantId) => {
    const expiring = await warrantyPipeline(Math.max(...NOTICE_THRESHOLDS));
    if (expiring.length === 0) return;

    const recipients = await admins(tenantId);
    if (recipients.length === 0) return;

    for (const asset of expiring) {
      const threshold = NOTICE_THRESHOLDS.find((t) => asset.daysRemaining <= t);
      if (threshold === undefined) continue;

      for (const recipient of recipients) {
        const sent = await notify({
          recipientId: recipient.membershipId,
          recipientEmail: recipient.email,
          type: 'warranty.expiring',
          title:
            asset.daysRemaining <= 0
              ? `Warranty expired: ${asset.name}`
              : `Warranty expires in ${asset.daysRemaining} days: ${asset.name}`,
          body: `${asset.name} (${asset.assetTag}) is covered until ${asset.expiresAt.toISOString().slice(0, 10)}.`,
          entityRef: { type: 'asset', id: asset.assetId },
          actionUrl: `/assets/${asset.assetId}`,
          channels: ['in_app', 'email'],
          // Per asset, per recipient, per threshold — sent once, not nightly.
          dedupeKey: `warranty:${asset.assetId}:${recipient.membershipId}:${threshold}`,
        });

        if (sent) notices += 1;
      }
    }
  });

  logger.info({ ...result, notices }, 'Warranty scan complete');
  return { tenants: result.tenants, notices };
}

interface Recipient {
  membershipId: string;
  email: string | null;
}

/** Active members who can act on an alert. */
async function admins(tenantId: string): Promise<Recipient[]> {
  const memberships = await MembershipModel.collection
    .find({ tenantId, status: 'active', deletedAt: null })
    .limit(25)
    .toArray();

  const recipients: Recipient[] = [];

  for (const membership of memberships) {
    const user = await UserModel.collection.findOne({
      _id: UserModel.base.Types.ObjectId.createFromHexString(String(membership.userId)),
    });

    recipients.push({
      membershipId: String(membership._id),
      email: (user?.email as string | undefined) ?? null,
    });
  }

  return recipients;
}

export async function rebuildAllMetrics(): Promise<{ tenants: number }> {
  const result = await eachActiveTenant('metrics-rollup', async () => {
    await rebuildDailyMetrics();
  });

  logger.info(result, 'Metrics rollup complete');
  return result;
}

export async function sweepStorage(): Promise<{ tenants: number; swept: number }> {
  let swept = 0;

  const result = await eachActiveTenant('storage-sweep', async () => {
    swept += await sweepAbandonedUploads();
  });

  return { tenants: result.tenants, swept };
}

/** Everything the nightly maintenance window runs. */
export async function runNightlyScans(): Promise<void> {
  const { reconcileAll } = await import('./reconciliation.service.js');

  // Reconciliation first: the rollup counts assigned assets, and reconciling
  // afterwards would leave the dashboard reporting yesterday's drift for a day.
  await reconcileAll({ repair: true });
  await rebuildAllMetrics();
  await scanExpiringWarranties();
  await sweepStorage();
}
