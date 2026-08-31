import { getContext } from '../../core/context/index.js';
import { logger } from '../../core/logging/index.js';
import { NotificationModel, type NotificationType } from './notification.model.js';
import { getEmailTransport } from './channels.js';

/**
 * The central dispatcher.
 *
 * Everything that needs to tell somebody something goes through here — one
 * place that knows about deduplication, preferences and channels, rather than
 * each feature inventing its own.
 */

export interface NotifyInput {
  recipientId: string;
  /** Absent means in-app only. */
  recipientEmail?: string | null;
  type: NotificationType;
  title: string;
  body?: string;
  entityRef?: { type: string; id: string };
  actionUrl?: string;
  /** Suppresses repeats — see the note on the model. */
  dedupeKey?: string;
  channels?: Array<'in_app' | 'email'>;
  expiresAt?: Date;
}

export async function notify(input: NotifyInput): Promise<boolean> {
  const channels = input.channels ?? ['in_app'];

  try {
    await NotificationModel.create({
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      entityRef: input.entityRef ?? {},
      actionUrl: input.actionUrl ?? null,
      channels,
      dedupeKey: input.dedupeKey ?? null,
      expiresAt: input.expiresAt ?? null,
      deliveredAt: new Date(),
    });
  } catch (err) {
    // The unique dedupe index rejecting a duplicate is success, not failure:
    // it is exactly what stops a nightly scan sending the same notice daily.
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }

  if (channels.includes('email') && input.recipientEmail) {
    // Never lets a mail failure fail the caller — a notification is a
    // side effect, and a warranty scan must not abort because SMTP blipped.
    try {
      await getEmailTransport().send({
        to: input.recipientEmail,
        subject: input.title,
        body: input.body ?? input.title,
        reference: input.dedupeKey,
      });
    } catch (err) {
      logger.error({ err, to: input.recipientEmail }, 'Email delivery failed');
    }
  }

  return true;
}

export async function listForRecipient(
  recipientId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
) {
  const filter: Record<string, unknown> = { recipientId };
  if (options.unreadOnly) filter.readAt = null;

  return NotificationModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 50)
    .exec();
}

export async function unreadCount(recipientId: string): Promise<number> {
  return NotificationModel.countDocuments({ recipientId, readAt: null });
}

export async function markRead(recipientId: string, ids: string[]): Promise<number> {
  // Scoped to the recipient: marking someone else's notification read would be
  // a small but real IDOR.
  const result = await NotificationModel.updateMany(
    { _id: { $in: ids }, recipientId, readAt: null },
    { $set: { readAt: new Date() } },
  );

  return result.modifiedCount;
}

export async function markAllRead(recipientId: string): Promise<number> {
  const result = await NotificationModel.updateMany(
    { recipientId, readAt: null },
    { $set: { readAt: new Date() } },
  );

  return result.modifiedCount;
}

/** The membership id of the current actor, for "my notifications". */
export function currentRecipientId(): string | undefined {
  return getContext()?.membershipId;
}
