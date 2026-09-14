import { logger } from '../../core/logging/index.js';

/**
 * Mail delivery behind a port.
 *
 * Resend in any environment with a key; a recording transport otherwise, so
 * development and tests exercise the whole path — render, log, queue, send —
 * and can assert on what would have been sent.
 */

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Resend deduplicates on this for 24 hours. The job queue retries a send whose
   * response was lost — a timeout after Resend accepted it — and without the key
   * that retry would deliver the message twice.
   */
  idempotencyKey: string;
  tags?: Record<string, string>;
}

export type SendOutcome =
  | { ok: true; providerId: string | null }
  | { ok: false; retryable: boolean; error: string };

export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendOutcome>;
}

/**
 * Resend's HTTP API, called directly.
 *
 * No SDK: this is one POST, and a dependency for it would be more code to keep
 * current than the request itself.
 */
export class ResendTransport implements EmailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: OutgoingEmail): Promise<SendOutcome> {
    let response: Response;

    try {
      response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          // Resend tag values allow letters, numbers, underscores and dashes only.
          tags: Object.entries(message.tags ?? {}).map(([name, value]) => ({
            name,
            value: value.replace(/[^A-Za-z0-9_-]/g, '_'),
          })),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Network failure or timeout: the idempotency key makes a retry safe.
      return { ok: false, retryable: true, error: `Could not reach Resend: ${(err as Error).message}` };
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { ok: true, providerId: body.id ?? null };
    }

    const detail = await response.text().catch(() => '');

    /*
     * Retry what can recover, and nothing else.
     *
     * 429 and 5xx are Resend being busy or down. Every other 4xx — an invalid
     * address, an unverified sending domain, a revoked key — fails identically
     * on every retry, and retrying it only delays the moment someone notices.
     */
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, error: `Resend ${response.status}: ${detail.slice(0, 300)}` };
  }
}

/**
 * Keeps messages instead of sending them.
 *
 * Not a no-op: the messages are inspectable, which is what lets a test assert
 * that a warranty scan produced an email rather than merely that it did not
 * throw. In development the log line shows the subject and recipient.
 */
export class RecordingTransport implements EmailTransport {
  readonly name = 'recording';
  readonly sent: OutgoingEmail[] = [];

  async send(message: OutgoingEmail): Promise<SendOutcome> {
    this.sent.push(message);
    logger.info({ to: message.to, subject: message.subject }, 'Email recorded (not sent — no RESEND_API_KEY)');
    return { ok: true, providerId: null };
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Messages addressed to one recipient, oldest first. */
  to(address: string): OutgoingEmail[] {
    return this.sent.filter((m) => m.to === address.toLowerCase());
  }
}
