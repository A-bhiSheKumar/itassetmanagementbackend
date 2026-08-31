import { logger } from '../../core/logging/index.js';
import { isProduction } from '../../config/index.js';

/**
 * Delivery channels behind an interface.
 *
 * In-app is a database write. Email is an interface with a recording transport
 * for development and tests — so the whole notification path is exercised and
 * assertable without an SMTP server, and swapping in Postmark or SES later
 * touches nothing above this file.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Correlates a delivery with the notification that caused it. */
  reference?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Records messages instead of sending them.
 *
 * Not a no-op: the messages are inspectable, which is what lets a test assert
 * that a warranty scan actually produced an email rather than merely that it
 * did not throw.
 */
export class RecordingEmailTransport implements EmailTransport {
  readonly name = 'recording';
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    logger.info({ to: message.to, subject: message.subject }, 'Email (not actually sent)');
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Messages addressed to one recipient, newest last. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }
}

let transport: EmailTransport = new RecordingEmailTransport();

export function getEmailTransport(): EmailTransport {
  if (isProduction && transport.name === 'recording') {
    // Loud, because silently dropping every customer email is the kind of
    // failure that goes unnoticed for weeks.
    logger.error('No email transport is configured — messages are being discarded');
  }
  return transport;
}

export function setEmailTransport(next: EmailTransport): void {
  transport = next;
}

export function recordingTransport(): RecordingEmailTransport {
  if (!(transport instanceof RecordingEmailTransport)) {
    throw new Error('The active email transport is not the recording one.');
  }
  return transport;
}
