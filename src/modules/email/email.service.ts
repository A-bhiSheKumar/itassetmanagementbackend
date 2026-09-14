import { env, isProduction } from '../../config/index.js';
import { getContext } from '../../core/context/index.js';
import { logger } from '../../core/logging/index.js';
import { QUEUE, getJobQueue } from '../../core/jobs/index.js';
import { EmailMessageModel, SuppressionModel, type EmailMessageDocument } from './email.model.js';
import { buildContent, SENSITIVE_TEMPLATES, type TemplateName, type TemplatePayloads } from './templates.js';
import { render } from './render.js';
import { RecordingTransport, ResendTransport, type EmailTransport } from './transport.js';

/**
 * The one way the product sends email.
 *
 *     await sendEmail({ template: 'notification', to, payload, dedupeKey: `warranty:${id}:30` });
 *
 * In order: suppression is checked, the message is rendered, a log row is
 * written (its dedupe key makes a repeated call a no-op), and a delivery job is
 * queued. The request that asked never waits on Resend, and a Resend outage
 * delays mail rather than failing anybody's action.
 *
 * This function never throws for a delivery problem. Sending mail is a side
 * effect; an invitation must still be created if email is briefly down.
 */

export interface SendEmailInput<N extends TemplateName> {
  template: N;
  to: string;
  payload: TemplatePayloads[N];
  /** One logical message, once. Omit only for mail that may legitimately repeat. */
  dedupeKey?: string;
  relatedTo?: { type: string; id: string };
}

export interface SendEmailResult {
  status: 'queued' | 'duplicate' | 'suppressed';
  messageId: string | null;
}

let transport: EmailTransport | undefined;

export function getEmailTransport(): EmailTransport {
  transport ??= env.RESEND_API_KEY ? new ResendTransport(env.RESEND_API_KEY) : new RecordingTransport();
  return transport;
}

export function setEmailTransport(next: EmailTransport | undefined): void {
  transport = next;
}

export function recordingTransport(): RecordingTransport {
  const current = getEmailTransport();
  if (!(current instanceof RecordingTransport)) throw new Error('The active email transport is not the recording one.');
  return current;
}

export async function isSuppressed(email: string): Promise<boolean> {
  return (await SuppressionModel.exists({ email: email.toLowerCase() }).exec()) !== null;
}

export async function sendEmail<N extends TemplateName>(input: SendEmailInput<N>): Promise<SendEmailResult> {
  const to = input.to.trim().toLowerCase();
  const rendered = render(buildContent(input.template, input.payload, { url: env.APP_URL, name: env.APP_NAME }), {
    productName: env.APP_NAME,
    footer: `You are receiving this because of your account with ${env.APP_NAME}.`,
  });

  const suppressed = await isSuppressed(to);

  let message: EmailMessageDocument;
  try {
    message = await EmailMessageModel.create({
      tenantRef: getContext()?.tenantId ?? null,
      template: input.template,
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // Recorded rather than silently dropped, so "why didn't they get it?" has
      // an answer.
      status: suppressed ? 'suppressed' : 'queued',
      dedupeKey: input.dedupeKey ?? null,
      relatedTo: input.relatedTo ?? { type: null, id: null },
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { status: 'duplicate', messageId: null };
    throw err;
  }

  if (suppressed) {
    logger.info({ to, template: input.template }, 'Email not sent: address is suppressed after a bounce or complaint');
    return { status: 'suppressed', messageId: String(message._id) };
  }

  try {
    await getJobQueue().add(
      QUEUE.email,
      { messageId: String(message._id) },
      // Six attempts over roughly fifteen minutes rides out a Resend incident
      // without leaving an invitation stuck for hours.
      { jobId: `email:${String(message._id)}`, attempts: 6, backoffMs: 30_000 },
    );
  } catch (err) {
    logger.error({ err, messageId: String(message._id) }, 'Could not queue an email for delivery');
  }

  return { status: 'queued', messageId: String(message._id) };
}

/**
 * Delivers one logged message. Runs as a job.
 *
 * Throws on a retryable failure so the queue retries with backoff; records and
 * returns on a permanent one, because retrying an invalid address or an
 * unverified domain only delays the moment somebody notices.
 */
export async function deliverEmail(messageId: string): Promise<void> {
  const message = await EmailMessageModel.findById(messageId).exec();
  if (!message || message.status !== 'queued') return;

  // Suppressed since it was queued — a bounce from an earlier message arrived.
  if (await isSuppressed(message.to)) {
    message.status = 'suppressed';
    redactIfSensitive(message);
    await message.save();
    return;
  }

  /*
   * Development safety. With a real Resend key outside production, mail goes to
   * MAIL_REDIRECT_TO; with no redirect it is refused outright. Seeded and test
   * data is full of addresses belonging to real people, and "I was just trying
   * it locally" is not an explanation anyone receiving the email accepts.
   */
  let deliverTo = message.to;
  const live = getEmailTransport().name !== 'recording';
  if (live && !isProduction) {
    if (!env.MAIL_REDIRECT_TO) {
      message.status = 'failed';
      message.lastError = 'Refused outside production: set MAIL_REDIRECT_TO to receive development mail.';
      await message.save();
      return;
    }
    deliverTo = env.MAIL_REDIRECT_TO;
  }

  message.attempts += 1;

  const outcome = await getEmailTransport().send({
    from: env.MAIL_FROM,
    to: deliverTo,
    ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    subject: deliverTo === message.to ? message.subject : `[to ${message.to}] ${message.subject}`,
    html: message.html,
    text: message.text,
    idempotencyKey: String(message._id),
    tags: { template: message.template },
  });

  if (outcome.ok) {
    message.status = 'sent';
    message.providerId = outcome.providerId;
    message.deliveredTo = deliverTo;
    message.sentAt = new Date();
    message.lastError = null;
    redactIfSensitive(message);
    await message.save();
    return;
  }

  message.lastError = outcome.error;

  if (!outcome.retryable) {
    message.status = 'failed';
    redactIfSensitive(message);
    await message.save();
    logger.error({ messageId, error: outcome.error }, 'Email permanently failed');
    return;
  }

  await message.save();
  // The queue owns the retry schedule and dead-letters after the last attempt.
  throw new Error(outcome.error);
}

const REDACTED = '[Removed after delivery: this message contained a single-use link.]';

/**
 * Erases the body of a message that carried a credential, once nothing will
 * send it again. The subject, recipient and outcome stay, so "did the
 * invitation go out?" is still answerable.
 */
function redactIfSensitive(message: EmailMessageDocument): void {
  if (!SENSITIVE_TEMPLATES.has(message.template as TemplateName)) return;
  message.html = REDACTED;
  message.text = REDACTED;
}

/** Records a delivery event from Resend's webhook. Safe to receive twice. */
export async function recordDeliveryEvent(input: {
  providerId: string;
  type: 'delivered' | 'bounced' | 'complained';
  email: string;
  detail?: string;
}): Promise<void> {
  const now = new Date();
  const update =
    input.type === 'delivered'
      ? { $set: { status: 'delivered', deliveredAt: now } }
      : input.type === 'bounced'
        ? { $set: { status: 'bounced', bouncedAt: now, lastError: input.detail ?? 'Bounced' } }
        : { $set: { status: 'complained', lastError: 'Marked as spam by the recipient' } };

  await EmailMessageModel.updateOne({ providerId: input.providerId }, update).exec();

  if (input.type === 'delivered') return;

  // Upsert: a second bounce for the same address changes nothing.
  await SuppressionModel.updateOne(
    { email: input.email.toLowerCase() },
    { $setOnInsert: { reason: input.type === 'bounced' ? 'bounce' : 'complaint', detail: input.detail ?? null } },
    { upsert: true },
  ).exec();

  logger.warn({ email: input.email, type: input.type }, 'Address suppressed after a delivery failure');
}
