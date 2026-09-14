import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/index.js';
import { logger } from '../../core/logging/index.js';
import { recordDeliveryEvent } from './email.service.js';

/**
 * Resend's delivery webhook: bounces, complaints, deliveries.
 *
 * Verified with Svix's scheme — HMAC-SHA256 over `id.timestamp.body`, keyed
 * with the base64 part of the `whsec_` secret — against the RAW body. A parsed
 * and re-serialised body differs in whitespace and key order, so it would fail
 * every legitimate signature; that is why this route sits ahead of the JSON
 * parser.
 *
 * An unverified request is refused. Without the check, anyone could post a fake
 * bounce for a customer's address and silently stop all of their mail.
 */

const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  signatureHeader: string;
  body: string;
  now?: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);

  // Refuses a replay of a genuine but old event.
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(input.secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${input.id}.${input.timestamp}.${input.body}`).digest();

  // The header can carry several signatures during secret rotation: "v1,abc v1,def".
  return input.signatureHeader.split(' ').some((part) => {
    const [version, signature] = part.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

interface ResendEvent {
  type: string;
  data?: { email_id?: string; to?: string[]; bounce?: { type?: string; message?: string } };
}

export async function resendWebhook(req: Request, res: Response): Promise<void> {
  const body = await readRaw(req);

  if (!env.RESEND_WEBHOOK_SECRET) {
    // Configuration refuses this in production; locally it just means not set up.
    res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Webhook not configured.' } });
    return;
  }

  const valid = verifySvixSignature({
    secret: env.RESEND_WEBHOOK_SECRET,
    id: String(req.headers['svix-id'] ?? ''),
    timestamp: String(req.headers['svix-timestamp'] ?? ''),
    signatureHeader: String(req.headers['svix-signature'] ?? ''),
    body,
  });

  if (!valid) {
    logger.warn({ ip: req.ip }, 'Rejected an unsigned or forged email webhook');
    res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid signature.' } });
    return;
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_FAILED', message: 'Malformed payload.' } });
    return;
  }

  const providerId = event.data?.email_id;
  const email = event.data?.to?.[0];

  if (providerId && email) {
    if (event.type === 'email.delivered') {
      await recordDeliveryEvent({ providerId, email, type: 'delivered' });
    } else if (event.type === 'email.bounced' && event.data?.bounce?.type !== 'Transient') {
      // A transient bounce is a full mailbox or a greylist: it may succeed later
      // and must not suppress the address for good.
      await recordDeliveryEvent({ providerId, email, type: 'bounced', detail: event.data?.bounce?.message });
    } else if (event.type === 'email.complained') {
      await recordDeliveryEvent({ providerId, email, type: 'complained' });
    }
  }

  // 200 for anything verified, including event types we ignore. Anything else
  // makes Resend retry a delivery that will never be handled differently.
  res.status(200).json({ success: true, data: { received: true } });
}

async function readRaw(req: Request): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Resend's events are a few kilobytes; nothing legitimate is larger.
    if (size > 256 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
