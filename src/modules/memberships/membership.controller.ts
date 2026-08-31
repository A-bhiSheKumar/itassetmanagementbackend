import type { Request, Response } from 'express';
import { ok, created, noContent } from '../../core/http/index.js';
import { assertWithinLimit, incrementUsage } from '../subscriptions/index.js';
import { isProduction } from '../../config/index.js';
import {
  listMembers,
  inviteMember,
  updateMemberRoles,
  suspendMember,
  reactivateMember,
} from './membership.service.js';

export async function index(_req: Request, res: Response): Promise<void> {
  const members = await listMembers();
  ok(
    res,
    members.map((m) => ({
      id: String(m._id),
      userId: m.userId,
      roleIds: m.roleIds,
      status: m.status,
      scope: m.scope,
      joinedAt: m.joinedAt,
      lastActiveAt: m.lastActiveAt,
    })),
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
