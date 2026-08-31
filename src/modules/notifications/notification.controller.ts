import type { Request, Response } from 'express';
import { ok } from '../../core/http/index.js';
import { UnauthenticatedError } from '../../core/errors/index.js';
import * as service from './notification.service.js';

function requireRecipient(): string {
  const id = service.currentRecipientId();
  // A user-scoped token has no membership, so no inbox.
  if (!id) throw new UnauthenticatedError('Choose an organisation first.');
  return id;
}

export async function index(req: Request, res: Response): Promise<void> {
  const recipientId = requireRecipient();
  const query = req.query as unknown as { unreadOnly?: boolean; limit: number };

  const [items, unread] = await Promise.all([
    service.listForRecipient(recipientId, { unreadOnly: query.unreadOnly, limit: query.limit }),
    service.unreadCount(recipientId),
  ]);

  ok(
    res,
    items.map((n) => ({
      id: String(n._id),
      type: n.type,
      title: n.title,
      body: n.body,
      entityRef: n.entityRef,
      actionUrl: n.actionUrl,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    { unreadCount: unread },
  );
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const { ids } = req.body as { ids: string[] };
  ok(res, { updated: await service.markRead(requireRecipient(), ids) });
}

export async function markAllRead(_req: Request, res: Response): Promise<void> {
  ok(res, { updated: await service.markAllRead(requireRecipient()) });
}
