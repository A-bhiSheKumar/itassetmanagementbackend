import type { Request, Response } from 'express';
import { ok } from '../../core/http/index.js';
import { getContextOrThrow } from '../../core/context/index.js';
import { INDUSTRY_PRESETS, applyPreset, findPreset } from '../catalog/index.js';
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

/**
 * The starter setups on offer.
 *
 * Public: the signup screen asks which kind of estate this is before anyone has
 * an account, and the list is static reference data with nothing tenant-specific in it.
 */
export async function industries(_req: Request, res: Response): Promise<void> {
  ok(
    res,
    INDUSTRY_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      vocabulary: p.vocabulary,
      modules: p.modules,
      examples: p.types.map((t) => t.name),
    })),
  );
}

/** Adds a preset's categories, types and fields to an organisation already running. */
export async function applyIndustryPreset(req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  const { industry, adoptWording } = req.body as { industry: string; adoptWording?: boolean };

  const added = await applyPreset(industry);
  const preset = findPreset(industry);

  const tenant = await updateSettings(ctx.tenantId!, {
    settings: {
      industry: preset.key,
      ...(adoptWording ? { vocabulary: preset.vocabulary, modules: preset.modules } : {}),
    },
  });

  ok(res, { added, tenant: present(tenant) });
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
