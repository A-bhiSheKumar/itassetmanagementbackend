import type { Request, Response } from 'express';
import { ok } from '../../core/http/index.js';
import { getContextOrThrow } from '../../core/context/index.js';
import { getUsage } from '../subscriptions/index.js';
import { getCurrentTenant, updateSettings } from './tenant.service.js';

function present(tenant: Awaited<ReturnType<typeof getCurrentTenant>>) {
  return {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    settings: tenant.settings,
    trialEndsAt: tenant.trialEndsAt,
  };
}

export async function show(_req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  ok(res, present(await getCurrentTenant(ctx.tenantId!)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  const tenant = await updateSettings(ctx.tenantId!, req.body as { name?: string });
  ok(res, present(tenant));
}

/**
 * Usage against entitlements.
 *
 * The frontend uses this to show "220 of 250 assets" and to warn before a
 * limit is hit — but the limit itself is enforced server-side on every create.
 */
export async function usage(_req: Request, res: Response): Promise<void> {
  ok(res, await getUsage());
}
