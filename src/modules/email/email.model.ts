import { Schema, type HydratedDocument, type Model } from 'mongoose';
import { defineModel, markSchemaGlobal } from '../../core/db/index.js';

/**
 * Every email the platform tries to send, and what became of it.
 *
 * The row is written BEFORE anything is sent. That ordering is the design:
 * the row is the idempotency key (a unique dedupe key per logical message), the
 * retry state (the job queue re-runs a send against it), and the answer to "did
 * the invitation actually go out, and did it bounce?".
 *
 * Global rather than tenant-scoped, deliberately. Some mail belongs to a person
 * rather than an organisation — a password reset is requested before anyone
 * has chosen a tenant — and delivery is a platform concern. `tenantRef` records
 * which organisation a message was for, as a reference. Nothing here is served
 * to tenants raw; where a tenant needs delivery status (a bounced invitation),
 * it is read into that tenant's own record by a service that filters by tenant.
 */

export const EMAIL_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'suppressed', 'bounced', 'complained'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const emailMessageSchema = markSchemaGlobal(
  new Schema(
    {
      tenantRef: { type: String, default: null },
      template: { type: String, required: true },
      to: { type: String, required: true, lowercase: true, trim: true },
      /** Where it actually went — differs from `to` only when development redirects mail. */
      deliveredTo: { type: String, default: null },
      subject: { type: String, required: true },
      html: { type: String, required: true },
      text: { type: String, required: true },

      status: { type: String, enum: EMAIL_STATUSES, default: 'queued' },
      attempts: { type: Number, default: 0 },
      lastError: { type: String, default: null },
      providerId: { type: String, default: null },

      /** One logical message, once: "invitation X", "warranty notice for asset Y on day 30". */
      dedupeKey: { type: String, default: null },
      relatedTo: {
        type: { type: String, default: null },
        id: { type: String, default: null },
      },

      sentAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      bouncedAt: { type: Date, default: null },

      /** Rendered bodies can hold personal data; they are not kept forever. */
      expireAt: { type: Date, default: () => new Date(Date.now() + 90 * 86_400_000) },
    },
    { timestamps: true },
  ),
);

emailMessageSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
// Webhooks find their message by the provider's id.
emailMessageSchema.index({ providerId: 1 }, { partialFilterExpression: { providerId: { $type: 'string' } } });
// "What happened to mail for this invitation?"
emailMessageSchema.index({ 'relatedTo.type': 1, 'relatedTo.id': 1, createdAt: -1 });
emailMessageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export interface EmailMessageRecord {
  tenantRef: string | null;
  template: string;
  to: string;
  deliveredTo: string | null;
  subject: string;
  html: string;
  text: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  providerId: string | null;
  dedupeKey: string | null;
  relatedTo: { type: string | null; id: string | null };
  sentAt: Date | null;
  deliveredAt: Date | null;
  bouncedAt: Date | null;
  expireAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailMessageDocument = HydratedDocument<EmailMessageRecord>;

export const EmailMessageModel = defineModel('EmailMessage', emailMessageSchema) as unknown as Model<EmailMessageRecord>;

/**
 * Addresses that must not be mailed again.
 *
 * A hard bounce means the mailbox does not exist; a complaint means the person
 * marked us as spam. Continuing to send to either is how a sending domain loses
 * its reputation, after which mail stops arriving for EVERY customer — so this
 * list is global, and consulted before every send.
 */
const suppressionSchema = markSchemaGlobal(
  new Schema(
    {
      email: { type: String, required: true, lowercase: true, trim: true },
      reason: { type: String, enum: ['bounce', 'complaint', 'manual'], required: true },
      detail: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

suppressionSchema.index({ email: 1 }, { unique: true });

export interface Suppression {
  email: string;
  reason: 'bounce' | 'complaint' | 'manual';
  detail: string | null;
  createdAt: Date;
}

export const SuppressionModel = defineModel('EmailSuppression', suppressionSchema) as unknown as Model<Suppression>;
