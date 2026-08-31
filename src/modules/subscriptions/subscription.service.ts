import { getTenantId } from '../../core/context/index.js';
import { upsertWithRetry } from '../../core/db/index.js';
import { EntitlementExceededError, SubscriptionInactiveError } from '../../core/errors/index.js';
import { PlanModel, DEFAULT_PLANS, type Entitlements } from './plan.model.js';
import { SubscriptionModel } from './subscription.model.js';
import { TenantUsageModel } from './tenantUsage.model.js';

const TRIAL_DAYS = 14;

/** Seeds the plan catalogue on first boot. Idempotent. */
export async function seedPlans(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await upsertWithRetry(() =>
      PlanModel.updateOne({ key: plan.key }, { $setOnInsert: plan }, { upsert: true }),
    );
  }
}

export async function startTrial(planKey = 'starter'): Promise<void> {
  const plan = await PlanModel.findOne({ key: planKey }).lean();
  if (!plan) throw new Error(`Plan "${planKey}" is not seeded.`);

  const now = new Date();
  const periodEnd = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);

  const entitlements = plan.entitlements as unknown as Entitlements;

  await SubscriptionModel.create({
    planId: String(plan._id),
    planKey: plan.key,
    status: 'trialing',
    seatsPurchased: entitlements.seats ?? 5,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    graceEndsAt: new Date(periodEnd.getTime() + 14 * 86_400_000),
  });

  await TenantUsageModel.create({ seatsUsed: 0, peopleCount: 0, assetCount: 0 });
}

export interface ResolvedEntitlements {
  entitlements: Entitlements;
  status: string;
  planKey: string;
  currentPeriodEnd: Date;
}

/**
 * Plan entitlements with any per-customer overrides applied.
 *
 * Overrides are how we say "give Acme 500 extra assets while they migrate"
 * without a new plan, a code change or a deploy.
 */
export async function resolveEntitlements(): Promise<ResolvedEntitlements> {
  const subscription = await SubscriptionModel.findOne({}).lean();
  if (!subscription) throw new SubscriptionInactiveError('missing');

  const plan = await PlanModel.findById(subscription.planId).lean();
  if (!plan) throw new SubscriptionInactiveError('plan_missing');

  return {
    entitlements: {
      ...(plan.entitlements as unknown as Entitlements),
      ...(subscription.entitlementOverrides as Partial<Entitlements>),
    },
    status: subscription.status,
    planKey: subscription.planKey,
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

export type CountableResource = 'seats' | 'people' | 'assets' | 'customFields';

type UsageField = 'seatsUsed' | 'peopleCount' | 'assetCount' | 'customFieldCount';

const USAGE_FIELD: Record<CountableResource, UsageField> = {
  seats: 'seatsUsed',
  people: 'peopleCount',
  assets: 'assetCount',
  customFields: 'customFieldCount',
};

const LIMIT_FIELD: Record<CountableResource, keyof Entitlements> = {
  seats: 'seats',
  people: 'people',
  assets: 'assets',
  customFields: 'customFields',
};

/**
 * Called before creating anything countable.
 *
 * Enforced server-side, never in the frontend (docs/07-security.md). A limit a
 * client can bypass by calling the API directly is not a limit.
 */
export async function assertWithinLimit(
  resource: CountableResource,
  adding = 1,
): Promise<void> {
  const { entitlements } = await resolveEntitlements();
  const limit = entitlements[LIMIT_FIELD[resource]] as number | null;

  if (limit === null || limit === undefined) return; // unlimited

  const usage = await TenantUsageModel.findOne({}).lean();
  const current = (usage?.[USAGE_FIELD[resource]] as number | undefined) ?? 0;

  if (current + adding > limit) {
    throw new EntitlementExceededError(resource, limit, current);
  }
}

export async function incrementUsage(resource: CountableResource, by = 1): Promise<void> {
  // Same upsert race as the tag counter: concurrent creates in a tenant whose
  // usage document does not yet exist all try to insert it.
  await upsertWithRetry(() =>
    TenantUsageModel.updateOne({}, { $inc: { [USAGE_FIELD[resource]]: by } }, { upsert: true }),
  );
}

export async function getUsage(): Promise<{
  usage: Record<string, number>;
  entitlements: Entitlements;
  status: string;
  planKey: string;
}> {
  const [usage, resolved] = await Promise.all([
    TenantUsageModel.findOne({}).lean(),
    resolveEntitlements(),
  ]);

  return {
    usage: {
      seats: usage?.seatsUsed ?? 0,
      people: usage?.peopleCount ?? 0,
      assets: usage?.assetCount ?? 0,
      storageBytes: usage?.storageBytes ?? 0,
      customFields: usage?.customFieldCount ?? 0,
    },
    entitlements: resolved.entitlements,
    status: resolved.status,
    planKey: resolved.planKey,
  };
}

/**
 * A lapsed subscription makes the tenant READ-ONLY. Reads and exports keep
 * working; only writes are refused (docs/06-edge-cases.md #20).
 */
export async function assertSubscriptionAllowsWrites(): Promise<void> {
  if (!getTenantId()) return;

  const subscription = await SubscriptionModel.findOne({}).lean();
  if (!subscription) return;

  const active = subscription.status === 'active' || subscription.status === 'trialing';
  if (active) return;

  const inGrace = subscription.graceEndsAt && subscription.graceEndsAt > new Date();
  if (inGrace) return;

  throw new SubscriptionInactiveError(subscription.status);
}
