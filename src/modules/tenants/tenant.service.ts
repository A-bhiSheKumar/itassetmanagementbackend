import { patchContext } from '../../core/context/index.js';
import { DuplicateValueError, NotFoundError } from '../../core/errors/index.js';
import { seedSystemRoles } from '../roles/index.js';
import { startTrial } from '../subscriptions/index.js';
import { seedCatalog } from '../catalog/index.js';
import { TenantModel, type TenantDocument } from './tenant.model.js';

const RESERVED_SLUGS = new Set([
  'api', 'app', 'www', 'admin', 'auth', 'login', 'signup', 'help', 'support',
  'status', 'docs', 'blog', 'about', 'billing', 'settings', 'platform', 'static',
]);

/** Slugs are permanent — a reused slug lets someone inherit stale links. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export async function isSlugAvailable(slug: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await TenantModel.findOne({ slug }).lean();
  return existing === null;
}

/**
 * Creates a tenant and everything it needs to function.
 *
 * Order matters: the tenant document must exist before the context can be
 * patched, and the context must carry a tenantId before any tenant-scoped write
 * (roles, subscription, usage) can succeed — the tenant-scope plugin refuses
 * them otherwise, which is exactly the behaviour we want.
 */
export async function createTenant(input: {
  name: string;
  slug?: string;
  ownerUserId: string;
}): Promise<TenantDocument> {
  const slug = input.slug ?? (await uniqueSlug(slugify(input.name)));

  if (!(await isSlugAvailable(slug))) {
    throw new DuplicateValueError('slug', slug);
  }

  const tenant = await TenantModel.create({
    name: input.name,
    slug,
    ownerUserId: input.ownerUserId,
    status: 'trialing',
    trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
  });

  // Everything below is tenant-scoped and needs the context to exist.
  patchContext({ tenantId: String(tenant._id) });

  await seedSystemRoles();
  await startTrial('starter');
  // Categories, asset types and the default lifecycle. A tenant that opens to
  // an empty screen has to invent a taxonomy before adding anything.
  await seedCatalog();

  return tenant;
}

async function uniqueSlug(base: string): Promise<string> {
  const candidate = base || 'org';
  if (await isSlugAvailable(candidate)) return candidate;

  for (let n = 2; n < 100; n += 1) {
    const next = `${candidate}-${n}`;
    if (await isSlugAvailable(next)) return next;
  }

  return `${candidate}-${Date.now().toString(36)}`;
}

export async function findTenantById(id: string): Promise<TenantDocument | null> {
  return TenantModel.findById(id).exec();
}

export async function getCurrentTenant(tenantId: string): Promise<TenantDocument> {
  const tenant = await TenantModel.findById(tenantId).exec();
  if (!tenant) throw new NotFoundError('Organisation');
  return tenant;
}

export async function updateSettings(
  tenantId: string,
  patch: { name?: string; settings?: Record<string, unknown> },
): Promise<TenantDocument> {
  const tenant = await getCurrentTenant(tenantId);

  if (patch.name) tenant.name = patch.name;
  if (patch.settings && tenant.settings) {
    // Merged, not replaced — a PATCH that omits a key must leave it alone.
    Object.assign(tenant.settings, patch.settings);
  }

  await tenant.save();
  return tenant;
}
