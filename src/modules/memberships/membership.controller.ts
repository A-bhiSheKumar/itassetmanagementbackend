import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import { isProduction } from '../../config/index.js';
import { UserModel } from '../identity/index.js';
import {
  listMembers,
  inviteMember,
  updateMemberRoles,
  suspendMember,
  reactivateMember,
} from './membership.service.js';

export async function index(_req: Request, res: Response): Promise<void> {
  const members = await listMembers();

  /*
   * A staff list has to name the staff.
   *
   * The membership record holds a `userId` and nothing else — correct, because
   * the person's name belongs to the user and not to their membership of one
   * tenant. But it left the console rendering a column of ObjectIds, which is
   * not a screen anybody can administer from.
   *
   * One batched lookup, never one per row.
   */
  const users = await UserModel.find({ _id: { $in: members.map((m) => m.userId) } })
    .select('name email')
    .lean();

  const identity = new Map(users.map((u) => [String(u._id), { name: u.name, email: u.email }]));

  ok(
    res,
    members.map((m) => {
      const user = identity.get(m.userId as string);

      return {
        id: String(m._id),
        userId: m.userId,
        // Null rather than "Unknown": an invited member has a membership before
        // they have an account, and that is a state worth showing as itself.
        name: user?.name ?? null,
        email: user?.email ?? null,
        roleIds: m.roleIds,
        status: m.status,
        scope: m.scope,
        joinedAt: m.joinedAt,
        lastActiveAt: m.lastActiveAt,
      };
    }),
  );
}

export async function invite(req: Request, res: Response): Promise<void> {
  const { email, roleIds } = req.body as { email: string; roleIds: string[] };

  // A seat is consumed by an invitation, not only by acceptance — otherwise a
  // tenant on a 5-seat plan can invite 500 people and blow past the limit the
  // moment they accept.
  await assertWithinLimit('seats');

  const result = await inviteMember({ email, roleIds });
  await incrementUsage('seats');

  created(res, {
    id: result.invitationId,
    email: result.email,
    // The email delivery job lands in M4. Until then the token is returned in
    // non-production so the flow is testable end to end. It must never leak in
    // production: an invitation token is a credential.
    ...(isProduction ? {} : { inviteToken: result.token }),
  });
}

export async function updateRoles(req: Request, res: Response): Promise<void> {
  const membership = await updateMemberRoles(req.params.id!, (req.body as { roleIds: string[] }).roleIds);
  ok(res, { id: String(membership._id), roleIds: membership.roleIds });
}

export async function suspend(req: Request, res: Response): Promise<void> {
  await suspendMember(req.params.id!);
  noContent(res);
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  await reactivateMember(req.params.id!);
  noContent(res);
}
