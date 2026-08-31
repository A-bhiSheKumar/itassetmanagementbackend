import type { Request, Response } from 'express';
import { ok } from '../../core/http/index.js';
import { ValidationError } from '../../core/errors/index.js';
import { recentActivity } from '../timeline/index.js';
import { currentMetrics, metricsHistory, rebuildDailyMetrics } from './metrics.service.js';
import { needsAttention, warrantyPipeline } from './attention.service.js';
import { offboardingChecklist, startOffboarding, completeOffboarding } from './offboarding.service.js';

/**
 * The dashboard, in one call.
 *
 * Counts come from the rollup (constant time at any estate size); the attention
 * rows are live, because each is a small set someone is expected to act on
 * today and a stale one would be worse than none.
 */
export async function dashboard(_req: Request, res: Response): Promise<void> {
  const [metrics, attention, activity] = await Promise.all([
    currentMetrics(),
    needsAttention(),
    recentActivity(10),
  ]);

  ok(res, {
    summary: {
      totalAssets: metrics.totalAssets,
      assignedAssets: metrics.assignedAssets,
      availableAssets: metrics.availableAssets,
      totalValueMinor: metrics.totalValueMinor,
      peopleCount: metrics.peopleCount,
      expiringWarranties30d: metrics.expiringWarranties30d,
    },
    byState: metrics.byState,
    byCategory: metrics.byCategory,
    byCondition: metrics.byCondition,
    attention,
    recentActivity: activity.map((e) => ({
      id: String(e._id),
      assetId: e.assetId,
      type: e.type,
      summary: e.summary,
      occurredAt: e.occurredAt,
      actorId: e.actorId,
    })),
    computedAt: metrics.computedAt,
  });
}

export async function warranties(req: Request, res: Response): Promise<void> {
  const { days } = req.query as unknown as { days: number };
  ok(res, await warrantyPipeline(days));
}

export async function history(req: Request, res: Response): Promise<void> {
  const { days } = req.query as unknown as { days: number };
  const rows = await metricsHistory(days);

  ok(
    res,
    rows.map((r) => ({
      date: r.date,
      totalAssets: r.totalAssets,
      assignedAssets: r.assignedAssets,
      totalValueMinor: r.totalValueMinor,
    })),
  );
}

/** Forces a rollup rebuild — useful after a bulk import, and in tests. */
export async function rebuild(_req: Request, res: Response): Promise<void> {
  const metrics = await rebuildDailyMetrics();
  ok(res, { computedAt: metrics.computedAt, totalAssets: metrics.totalAssets });
}

export async function checklist(req: Request, res: Response): Promise<void> {
  ok(res, await offboardingChecklist(req.params.id!));
}

export async function start(req: Request, res: Response): Promise<void> {
  ok(res, await startOffboarding(req.params.id!));
}

export async function complete(req: Request, res: Response): Promise<void> {
  const body = req.body as { force?: boolean };
  const result = await completeOffboarding(req.params.id!, body);

  if (!result.clearToDeactivate && !body.force) {
    // A refusal that lists exactly what is still out, so the answer is
    // actionable rather than "no".
    throw new ValidationError(
      `${result.personName} still holds ${result.outstanding.length} item${
        result.outstanding.length === 1 ? '' : 's'
      }. Collect them, or confirm the write-off.`,
      { outstanding: result.outstanding.map((i) => `${i.assetTag} — ${i.assetName}`) },
    );
  }

  ok(res, result);
}
