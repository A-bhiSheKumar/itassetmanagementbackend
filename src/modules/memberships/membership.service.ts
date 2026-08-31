import { getContextOrThrow } from '../../core/context/index.js';
import { LastOwnerError, NotFoundError, DuplicateValueError } from '../../core/errors/index.js';
import { generateToken, hashToken } from '../../core/auth/index.js';
import type { Permission } from '../../core/authz/index.js';
import { resolvePermissions, findRoleByKey, assertCanGrantRoles } from '../roles/index.js';
import { MembershipModel, type MembershipDocument } from './membership.model.js';
import { InvitationModel } from './invitation.model.js';

const INVITE_TTL_DAYS = 7;

/**
 * Every membership a user holds, across all tenants.
 *
 * The one deliberately cross-tenant query in the system: it runs at login,
 * before a tenant has been chosen, so there is nothing to scope it by. It is
 * filtered by userId — the authenticated user's own — and returns only ids and
 * names, never business data.
 */
export async function listMembershipsForUser(userId: string) {
  return MembershipModel.collection
    .find({ userId, status: { $in: ['active', 'invited'] }, deletedAt: null })
    .project({ tenantId: 1, status: 1, roleIds: 1 })
    .toArray();
}

export async function findMembership(
  tenantId: string,
  userId: string,
): Promise<MembershipDocument | null> {
  // Bypasses the plugin deliberately: this runs during authentication, before
  // a tenant context exists — the membership is what establishes it.
  const raw = await MembershipModel.collection.findOne({ tenantId, userId, deletedAt: null });
  return raw ? MembershipModel.hydrate(raw) : null;
}

export async function createOwnerMembership(userId: string): Promise<MembershipDocument> {
  const ownerRole = await findRoleByKey('owner');
  if (!ownerRole) throw new Error('System roles are not seeded for this tenant.');

  return MembershipModel.create({
    userId,
    roleIds: [String(ownerRole._id)],
    status: 'active',
    joinedAt: new Date(),
  });
}

export async function permissionsForMembership(
  membership: MembershipDocument,
): Promise<Set<Permission>> {
  return resolvePermissions(membership.roleIds);
}

export function listMembers() {
  return MembershipModel.find({}).sort({ createdAt: -1 }).exec();
}

/**
 * Blocks removing, demoting or suspending the last Owner
 * (docs/06-edge-cases.md #24).
 *
 * Applies to delete, demote, suspend AND self-demotion — an organisation with
 * no Owner cannot manage billing or transfer ownership, and only we can fix it.
 */
export async function assertNotLastOwner(membershipId: string): Promise<void> {
  const ownerRole = await findRoleByKey('owner');
  if (!ownerRole) return;

  const ownerRoleId = String(ownerRole._id);

  const target = await MembershipModel.findById(membershipId).lean();
  if (!target || !target.roleIds.includes(ownerRoleId)) return;

  const otherOwners = await MembershipModel.countDocuments({
    _id: { $ne: membershipId },
    roleIds: ownerRoleId,
    status: 'active',
  });

  if (otherOwners === 0) throw new LastOwnerError();
}

export interface InviteResult {
  invitationId: string;
  /** Returned once, delivered by email. Only the hash is stored. */
  token: string;
  email: string;
}

export async function inviteMember(input: {
  email: string;
  roleIds: string[];
}): Promise<InviteResult> {
  const ctx = getContextOrThrow();

  // Privilege escalation guard: you cannot invite someone into a role that
  // grants more than you hold.
  await assertCanGrantRoles(ctx.permissions, input.roleIds);

  const existingMember = await MembershipModel.findOne({}).where('userId').ne(null).lean();
  void existingMember;

  const token = generateToken();

  try {
    const invitation = await InvitationModel.create({
      email: input.email,
      roleIds: input.roleIds,
      tokenHash: hashToken(token),
      invitedBy: ctx.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    });

    return { invitationId: String(invitation._id), token, email: input.email };
  } catch (err) {
    // The partial unique index on (tenantId, email) for unresolved invitations.
    if ((err as { code?: number }).code === 11000) {
      throw new DuplicateValueError('email', input.email);
    }
    throw err;
  }
}

export async function updateMemberRoles(
  membershipId: string,
  roleIds: string[],
): Promise<MembershipDocument> {
  const ctx = getContextOrThrow();
  await assertCanGrantRoles(ctx.permissions, roleIds);

  const membership = await MembershipModel.findById(membershipId);
  if (!membership) throw new NotFoundError('Member');

  // Demoting the last Owner leaves the organisation unmanageable.
  const ownerRole = await findRoleByKey('owner');
  if (ownerRole && !roleIds.includes(String(ownerRole._id))) {
    await assertNotLastOwner(membershipId);
  }

  membership.roleIds = roleIds;
  // Invalidates the permission cache and every outstanding access token.
  membership.permVersion += 1;
  await membership.save();

  return membership;
}

export async function suspendMember(membershipId: string): Promise<MembershipDocument> {
  await assertNotLastOwner(membershipId);

  const membership = await MembershipModel.findById(membershipId);
  if (!membership) throw new NotFoundError('Member');

  membership.status = 'suspended';
  membership.permVersion += 1;
  await membership.save();

  return membership;
}

export async function reactivateMember(membershipId: string): Promise<MembershipDocument> {
  const membership = await MembershipModel.findById(membershipId);
  if (!membership) throw new NotFoundError('Member');

  membership.status = 'active';
  membership.permVersion += 1;
  await membership.save();

  return membership;
}

export async function findInvitationByToken(token: string) {
  const raw = await InvitationModel.collection.findOne({
    tokenHash: hashToken(token),
    acceptedAt: null,
    revokedAt: null,
    deletedAt: null,
  });

  if (!raw || raw.expiresAt < new Date()) return null;
  return raw;
}
