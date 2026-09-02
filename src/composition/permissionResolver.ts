/**
 * Wiring, not domain logic.
 *
 * This implements the `PermissionResolver` port that the auth middleware
 * defines, and to do it it needs BOTH identity (who is this) and memberships
 * (what may they do here). That makes it composition: the one place allowed to
 * know about two modules at once.
 *
 * It used to live in `modules/identity`, which forced identity to depend on
 * memberships. That was fine until memberships needed a user's name for its own
 * listing — at which point the two modules pointed at each other and the
 * boundary was gone. Sitting above both, nothing is circular and each module
 * keeps one direction of dependency.
 */
import { ulid } from 'ulid';
import type { PermissionResolver } from '../core/http/middleware/authenticate.middleware.js';
import { getContext, runWithContext } from '../core/context/index.js';
import { MembershipModel, permissionsForMembership } from '../modules/memberships/index.js';
import { UserModel } from '../modules/identity/index.js';

/**
 * Wires the auth middleware to the data layer.
 *
 * Lives in the identity module rather than in core/ so that core stays free of
 * business dependencies — core is framework, and framework must not import
 * modules (enforced by dependency-cruiser).
 *
 * Both lookups deliberately use the raw collection: they run BEFORE the tenant
 * context exists, since resolving the membership is what establishes it. The
 * tenantId is taken from the signed token and matched exactly, so this cannot
 * read across tenants.
 */
export const permissionResolver: PermissionResolver = {
  async resolve({ userId, tenantId, membershipId }) {
    const raw = await MembershipModel.collection.findOne({
      _id: MembershipModel.base.Types.ObjectId.createFromHexString(membershipId),
      tenantId,
      userId,
      deletedAt: null,
    });

    if (!raw) return null;

    const user = await UserModel.collection.findOne({
      _id: UserModel.base.Types.ObjectId.createFromHexString(userId),
    });

    if (!user || user.status !== 'active') return null;

    const membership = MembershipModel.hydrate(raw);

    /**
     * Roles are tenant-scoped, and this runs BEFORE the request context has a
     * tenant — resolving the membership is what establishes it. So the role
     * lookup gets an explicit context built from the tenantId in the verified
     * token.
     *
     * This ordering bug shipped once: the role query ran unscoped and threw.
     * Worth noting what the alternative design would have done — a plugin that
     * silently returned an unfiltered result would have loaded EVERY tenant's
     * roles here and granted the union of their permissions to whoever asked.
     * That is the case for failing loudly.
     */
    const permissions = await runWithContext(
      {
        requestId: getContext()?.requestId ?? ulid(),
        tenantId,
        userId,
        permissions: new Set<string>(),
        actorType: 'user',
      },
      async () => permissionsForMembership(membership),
    );

    return {
      permissions: permissions as Set<string>,
      permVersion: raw.permVersion as number,
      tokenVersion: user.tokenVersion as number,
      scope: raw.scope,
      membershipStatus: raw.status as string,
    };
  },

  async userTokenVersion(userId) {
    let objectId;
    try {
      objectId = UserModel.base.Types.ObjectId.createFromHexString(userId);
    } catch {
      return null;
    }

    const user = await UserModel.collection.findOne({ _id: objectId });
    if (!user || user.status !== 'active') return null;
    return user.tokenVersion as number;
  },
};
