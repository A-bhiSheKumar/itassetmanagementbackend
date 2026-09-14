import { env } from '../../config/index.js';
import { getContextOrThrow } from '../../core/context/index.js';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { generateToken, hashToken } from '../../core/auth/index.js';
import { findRolesByIds } from '../roles/index.js';
import { findTenantById } from '../tenants/index.js';
import { incrementUsage } from '../subscriptions/index.js';
import { EmailMessageModel, absolute, sendEmail } from '../email/index.js';
import { InvitationModel } from './invitation.model.js';
import { userDirectory } from './userDirectory.js';

/**
 * Invitations after they are created: the email, the pending list, resending
 * and revoking.
 *
 * The token never leaves this process except inside the email. It used to be
 * returned in the API response outside production so the flow could be tested
 * before email existed — which also meant anyone watching the network tab of
 * an admin's browser could accept someone else's invitation.
 */

export const INVITE_TTL_DAYS = 7;

const formatDate = (date: Date) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);

export async function sendInvitationEmail(invitation: {
  _id: unknown;
  email: string;
  roleIds: string[];
  invitedBy: string;
  expiresAt: Date;
}, token: string): Promise<void> {
  const ctx = getContextOrThrow();

  const [tenant, roles, inviter] = await Promise.all([
    findTenantById(ctx.tenantId!),
    findRolesByIds(invitation.roleIds),
    userDirectory().namesFor([invitation.invitedBy]),
  ]);

  await sendEmail({
    template: 'invitation',
    to: invitation.email,
    payload: {
      organisationName: tenant?.name ?? 'your organisation',
      inviterName: inviter.get(invitation.invitedBy)?.name ?? null,
      roleNames: roles.map((r) => r.name),
      acceptUrl: absolute(`/accept-invitation?token=${encodeURIComponent(token)}`, env.APP_URL),
      expiresAt: formatDate(invitation.expiresAt),
    },
    relatedTo: { type: 'invitation', id: String(invitation._id) },
  });
}

export interface PendingInvitation {
  id: string;
  email: string;
  roleIds: string[];
  invitedBy: string;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
  /** What happened to the most recent email: queued, sent, delivered, bounced… */
  emailStatus: string | null;
}

/** Invitations nobody has accepted or revoked, newest first. */
export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  const ctx = getContextOrThrow();
  const rows = await InvitationModel.find({ acceptedAt: null, revokedAt: null }).sort({ createdAt: -1 }).limit(200).lean();

  const ids = rows.map((r) => String(r._id));
  const [names, messages] = await Promise.all([
    userDirectory().namesFor(rows.map((r) => r.invitedBy)),
    // The log is global; it is read here only for this tenant's own invitations.
    EmailMessageModel.find({ tenantRef: ctx.tenantId, 'relatedTo.type': 'invitation', 'relatedTo.id': { $in: ids } })
      .sort({ createdAt: -1 })
      .select('relatedTo status')
      .lean(),
  ]);

  const latest = new Map<string, string>();
  for (const m of messages) {
    const key = m.relatedTo?.id;
    if (key && !latest.has(key)) latest.set(key, m.status);
  }

  const now = new Date();
  return rows.map((r) => ({
    id: String(r._id),
    email: r.email,
    roleIds: r.roleIds,
    invitedBy: r.invitedBy,
    invitedByName: names.get(r.invitedBy)?.name ?? null,
    createdAt: r.createdAt as Date,
    expiresAt: r.expiresAt,
    expired: r.expiresAt < now,
    emailStatus: latest.get(String(r._id)) ?? null,
  }));
}

/**
 * Sends a fresh link and restarts the clock.
 *
 * A new token replaces the old one, so a link forwarded or leaked before the
 * resend stops working.
 */
export async function resendInvitation(id: string): Promise<{ id: string; expiresAt: Date }> {
  const invitation = await InvitationModel.findOne({ _id: id, acceptedAt: null, revokedAt: null }).exec();
  if (!invitation) throw new NotFoundError('Invitation');

  const token = generateToken();
  invitation.tokenHash = hashToken(token);
  invitation.expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
  await invitation.save();

  await sendInvitationEmail(invitation as never, token);
  return { id, expiresAt: invitation.expiresAt };
}

/** Withdraws an invitation. Its link stops working and the seat it held is released. */
export async function revokeInvitation(id: string): Promise<void> {
  const invitation = await InvitationModel.findOne({ _id: id, acceptedAt: null }).exec();
  if (!invitation) throw new NotFoundError('Invitation');
  if (invitation.revokedAt) throw new ValidationError('This invitation was already withdrawn.', { id: ['Already revoked.'] });

  invitation.revokedAt = new Date();
  await invitation.save();
  await incrementUsage('seats', -1);
}
