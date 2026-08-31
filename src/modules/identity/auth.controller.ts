import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { getContextOrThrow, patchContext, runWithContext } from '../../core/context/index.js';
import { UnauthenticatedError, NotFoundError } from '../../core/errors/index.js';
import {
  signUserToken,
  signTenantToken,
  REFRESH_COOKIE,
  refreshCookieOptions,
  refreshCookieAttributes,
} from '../../core/auth/index.js';
import { isProduction } from '../../config/index.js';
import { createTenant, findTenantById } from '../tenants/index.js';
import {
  createOwnerMembership,
  findMembership,
  listMembershipsForUser,
  permissionsForMembership,
  MembershipModel,
  findInvitationByToken,
} from '../memberships/index.js';
import { incrementUsage } from '../subscriptions/index.js';
import {
  createUser,
  authenticate,
  findUserById,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  changePassword,
} from './identity.service.js';

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(isProduction));
}

function requestMeta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/**
 * Sign up: creates a user, an organisation, and the owner membership.
 *
 * Runs in one flow so a half-created tenant — a user with no organisation, or
 * an organisation with no owner — is not reachable.
 */
export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, name, organisationName } = req.body as {
    email: string;
    password: string;
    name: string;
    organisationName: string;
  };

  const user = await createUser({ email, password, name });
  const userId = String(user._id);

  patchContext({ userId });

  const tenant = await createTenant({ name: organisationName, ownerUserId: userId });
  const membership = await createOwnerMembership(userId);
  await incrementUsage('seats');

  user.defaultTenantId = String(tenant._id);
  await user.save();

  const refresh = await issueRefreshToken({ userId, ...requestMeta(req) });
  setRefreshCookie(res, refresh.token);

  created(res, {
    accessToken: signTenantToken({
      userId,
      tenantId: String(tenant._id),
      membershipId: String(membership._id),
      permVersion: membership.permVersion,
      tokenVersion: user.tokenVersion,
    }),
    user: { id: userId, email: user.email, name: user.name },
    tenant: { id: String(tenant._id), name: tenant.name, slug: tenant.slug },
  });
}

/**
 * Sign in. Authenticates the USER, not a tenant.
 *
 * The response is a user-scoped token plus the list of organisations. Choosing
 * one is a separate call — which is what makes belonging to several
 * organisations a normal case rather than a workaround (ADR-003).
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  const user = await authenticate(email, password);
  const userId = String(user._id);

  const memberships = await listMembershipsForUser(userId);
  const tenants = await Promise.all(
    memberships.map(async (m) => {
      const tenant = await findTenantById(m.tenantId as string);
      return tenant
        ? {
            tenantId: String(tenant._id),
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status,
            membershipStatus: m.status as string,
          }
        : null;
    }),
  );

  const refresh = await issueRefreshToken({ userId, ...requestMeta(req) });
  setRefreshCookie(res, refresh.token);

  ok(res, {
    accessToken: signUserToken({ userId, tokenVersion: user.tokenVersion }),
    user: { id: userId, email: user.email, name: user.name },
    organisations: tenants.filter(Boolean),
    defaultTenantId: user.defaultTenantId,
  });
}

/** Exchanges a user token for a tenant-scoped one. Not a re-login. */
export async function selectTenant(req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  const { tenantId } = req.body as { tenantId: string };

  if (!ctx.userId) throw new UnauthenticatedError();

  const membership = await findMembership(tenantId, ctx.userId);
  // 404, not 403: confirming that a tenant exists would let anyone enumerate
  // our customer list (ADR-015).
  if (!membership || membership.status !== 'active') throw new NotFoundError('Organisation');

  const tenant = await findTenantById(tenantId);
  if (!tenant || tenant.status === 'deleted') throw new NotFoundError('Organisation');

  const user = await findUserById(ctx.userId);
  if (!user) throw new UnauthenticatedError();

  await MembershipModel.collection.updateOne(
    { _id: membership._id },
    { $set: { lastActiveAt: new Date() } },
  );

  ok(res, {
    accessToken: signTenantToken({
      userId: ctx.userId,
      tenantId,
      membershipId: String(membership._id),
      permVersion: membership.permVersion,
      tokenVersion: user.tokenVersion,
    }),
    tenant: { id: tenantId, name: tenant.name, slug: tenant.slug, status: tenant.status },
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!presented) throw new UnauthenticatedError('No session found.');

  const rotated = await rotateRefreshToken(presented, requestMeta(req));
  setRefreshCookie(res, rotated.token);

  const user = await findUserById(rotated.userId);
  if (!user || user.status !== 'active') throw new UnauthenticatedError();

  ok(res, {
    accessToken: signUserToken({
      userId: rotated.userId,
      tokenVersion: user.tokenVersion,
    }),
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (presented) await revokeRefreshToken(presented);

  res.clearCookie(REFRESH_COOKIE, refreshCookieAttributes(isProduction));
  noContent(res);
}

/**
 * Accepting an invitation.
 *
 * If the email already has an account, we link a new membership rather than
 * creating a second user (docs/06-edge-cases.md #26). Two accounts for one
 * person breaks tenant switching and double-counts seats.
 */
export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  const { token, password, name } = req.body as {
    token: string;
    password?: string;
    name?: string;
  };

  const invitation = await findInvitationByToken(token);
  if (!invitation) throw new NotFoundError('Invitation');

  const tenantId = invitation.tenantId as string;
  const { findUserByEmail } = await import('./identity.service.js');

  let user = await findUserByEmail(invitation.email as string);

  if (!user) {
    if (!password || !name) {
      throw new UnauthenticatedError('Set a name and password to accept this invitation.');
    }
    user = await createUser({ email: invitation.email as string, password, name });
  }

  const userId = String(user._id);

  await runWithContext(
    { requestId: getContextOrThrow().requestId, tenantId, userId, permissions: new Set(), actorType: 'user' },
    async () => {
      await MembershipModel.create({
        userId,
        roleIds: invitation.roleIds,
        status: 'active',
        invitedBy: invitation.invitedBy,
        joinedAt: new Date(),
      });

      await MembershipModel.collection.updateOne(
        { _id: invitation._id },
        { $set: { acceptedAt: new Date() } },
      );
    },
  );

  const { InvitationModel } = await import('../memberships/index.js');
  await InvitationModel.collection.updateOne(
    { _id: invitation._id },
    { $set: { acceptedAt: new Date() } },
  );

  const refreshToken = await issueRefreshToken({ userId, ...requestMeta(req) });
  setRefreshCookie(res, refreshToken.token);

  ok(res, {
    accessToken: signUserToken({ userId, tokenVersion: user.tokenVersion }),
    user: { id: userId, email: user.email, name: user.name },
  });
}

/** The current user, their organisations, and their effective permissions. */
export async function me(_req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  if (!ctx.userId) throw new UnauthenticatedError();

  const user = await findUserById(ctx.userId);
  if (!user) throw new UnauthenticatedError();

  const memberships = await listMembershipsForUser(ctx.userId);
  const organisations = (
    await Promise.all(
      memberships.map(async (m) => {
        const tenant = await findTenantById(m.tenantId as string);
        return tenant
          ? { tenantId: String(tenant._id), name: tenant.name, slug: tenant.slug }
          : null;
      }),
    )
  ).filter(Boolean);

  let permissions: string[] = [];
  if (ctx.tenantId && ctx.membershipId) {
    const membership = await MembershipModel.findById(ctx.membershipId).exec();
    if (membership) permissions = [...(await permissionsForMembership(membership))];
  }

  ok(res, {
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
    },
    organisations,
    currentTenantId: ctx.tenantId ?? null,
    // The frontend uses these to hide unusable controls. It is a convenience:
    // every one of them is checked server-side on the actual request.
    permissions,
  });
}

export async function updatePassword(req: Request, res: Response): Promise<void> {
  const ctx = getContextOrThrow();
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };

  await changePassword(ctx.userId!, currentPassword, newPassword);

  res.clearCookie(REFRESH_COOKIE, refreshCookieAttributes(isProduction));
  noContent(res);
}
