import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { patchContext } from '../../context/index.js';
import { verifyAccessToken, isTenantToken } from '../../auth/index.js';
import { UnauthenticatedError } from '../../errors/index.js';

/**
 * Populates the request context from the Authorization header.
 *
 * Optional by design: it never rejects an anonymous request. Enforcement is the
 * job of requireAuth()/requirePermission() on each route, so a public endpoint
 * and a guarded one share one code path and there is no chance of a route being
 * accidentally exempted from authentication by middleware ordering.
 *
 * ── Claims are a cache, not authority ──────────────────────────────────────
 * `tv` (token version) and `pv` (permission version) in the token are compared
 * against the database on every request. A mismatch rejects the token. That is
 * what makes "revoke this admin's access" take effect immediately rather than
 * whenever their 15-minute token happens to expire.
 */
export interface PermissionResolver {
  resolve(input: { userId: string; tenantId: string; membershipId: string }): Promise<{
    permissions: Set<string>;
    permVersion: number;
    tokenVersion: number;
    scope?: {
      type: 'all' | 'department' | 'location';
      departmentIds?: string[];
      locationIds?: string[];
    };
    membershipStatus: string;
  } | null>;

  userTokenVersion(userId: string): Promise<number | null>;
}

export function authenticate(resolver: PermissionResolver): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');

    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }

    try {
      const claims = verifyAccessToken(header.slice(7));

      if (!isTenantToken(claims)) {
        // A user-scoped token: authenticated, but no tenant chosen yet. It can
        // list organisations and select one — nothing else.
        const tokenVersion = await resolver.userTokenVersion(claims.sub);
        if (tokenVersion === null || tokenVersion !== claims.tv) {
          throw new UnauthenticatedError('That session is no longer valid.');
        }

        patchContext({ userId: claims.sub });
        next();
        return;
      }

      const resolved = await resolver.resolve({
        userId: claims.sub,
        tenantId: claims.tid,
        membershipId: claims.mid,
      });

      // Membership revoked, suspended, or the tenant deleted since the token
      // was minted.
      if (!resolved || resolved.membershipStatus !== 'active') {
        throw new UnauthenticatedError('Your access to this organisation has changed.');
      }

      // Global sign-out, or a password change.
      if (resolved.tokenVersion !== claims.tv) {
        throw new UnauthenticatedError('That session is no longer valid.');
      }

      // Roles changed since the token was minted — force a refresh so the new
      // permission set takes effect rather than the stale one in the token.
      if (resolved.permVersion !== claims.pv) {
        throw new UnauthenticatedError('Your permissions have changed. Please retry.');
      }

      patchContext({
        userId: claims.sub,
        tenantId: claims.tid,
        membershipId: claims.mid,
        permissions: resolved.permissions,
        scope: resolved.scope,
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
