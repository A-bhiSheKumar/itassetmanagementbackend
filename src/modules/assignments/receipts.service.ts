import { ulid } from 'ulid';
import { env } from '../../config/index.js';
import { getContext, runWithContext } from '../../core/context/index.js';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { generateToken, hashToken } from '../../core/auth/index.js';
import { withTransaction } from '../../core/db/index.js';
import { emit, flushOutbox } from '../../core/events/index.js';
import { AssetModel } from '../assets/index.js';
import { PersonModel } from '../people/index.js';
import { findTenantById } from '../tenants/index.js';
import { absolute, sendEmail } from '../email/index.js';
import { AssignmentModel, type AssignmentDocument } from './assignment.model.js';

/**
 * "Please confirm you received this" — and the reminders that follow.
 *
 * The person confirming usually has no login: they are an employee who was
 * handed a laptop. The single-use link in their email is the whole credential,
 * so confirming is a public endpoint that finds its organisation from the
 * token rather than from a session.
 */

const formatDate = (date: Date) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Who a receipt request would go to, refusing up front when there is nobody.
 *
 * Called before the assignment is written, so "ask them to confirm" on a person
 * with no email fails as a form error rather than as an assignment that waits
 * forever for a confirmation nobody was asked for.
 */
export async function assertCanRequestReceipt(assigneeType: string, assigneeId: string): Promise<void> {
  if (assigneeType !== 'person') {
    throw new ValidationError('Only a person can confirm receipt.', {
      requireAcknowledgement: ['Only available when assigning to a person.'],
    });
  }

  const person = await PersonModel.findById(assigneeId).select('email').lean();
  if (!person?.email) {
    throw new ValidationError('This person has no email address, so they cannot be asked to confirm receipt.', {
      requireAcknowledgement: ['Add an email address to this person first.'],
    });
  }
}

export function newReceiptToken(): { token: string; acknowledgement: Record<string, unknown> } {
  const token = generateToken();
  return { token, acknowledgement: { requiredAt: new Date(), tokenHash: hashToken(token), method: 'link' } };
}

async function receiptDetails(assignment: { assetId: string; assigneeId: string }) {
  const [asset, person, tenant] = await Promise.all([
    AssetModel.findById(assignment.assetId).select('name assetTag serialNumber').lean(),
    PersonModel.findById(assignment.assigneeId).select('firstName lastName email').lean(),
    findTenantById(getContext()!.tenantId!),
  ]);
  return { asset, person, organisationName: tenant?.name ?? 'Your organisation' };
}

export async function sendReceiptRequest(
  assignment: { _id: unknown; assetId: string; assigneeId: string },
  token: string,
  options: { reminder: boolean; dedupeKey?: string },
): Promise<'queued' | 'duplicate' | 'suppressed'> {
  const { asset, person, organisationName } = await receiptDetails(assignment);
  if (!asset || !person?.email) return 'suppressed';

  const result = await sendEmail({
    template: 'receiptRequest',
    to: person.email,
    payload: {
      personName: person.firstName,
      organisationName,
      assetName: asset.name,
      assetTag: asset.assetTag,
      serialNumber: asset.serialNumber ?? null,
      confirmUrl: absolute(`/confirm-receipt?token=${encodeURIComponent(token)}`, env.APP_URL),
      reminder: options.reminder,
    },
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    relatedTo: { type: 'assignment', id: String(assignment._id) },
  });

  return result.status;
}

/**
 * Nudges whoever holds an asset: to confirm receipt if they have not, or to
 * bring it back if it is due or overdue. Once a day per assignment at most —
 * the dedupe key carries the date.
 */
export async function remindAssignment(id: string): Promise<{ sent: 'receipt' | 'return' }> {
  const assignment = await AssignmentModel.findOne({ _id: id, status: 'active' }).exec();
  if (!assignment) throw new NotFoundError('Assignment');

  const pendingReceipt = assignment.acknowledgement?.requiredAt && !assignment.acknowledgement.acknowledgedAt;

  if (pendingReceipt) {
    const { token, acknowledgement } = newReceiptToken();
    const status = await sendReceiptRequest(assignment, token, { reminder: true, dedupeKey: `receipt-reminder:${id}:${today()}` });
    assertSent(status);
    // Only once the email is queued: a refused reminder must not invalidate the link they already have.
    assignment.acknowledgement!.tokenHash = acknowledgement.tokenHash as string;
    await assignment.save();
    return { sent: 'receipt' };
  }

  if (assignment.dueAt && assignment.assigneeType === 'person') {
    const { asset, person, organisationName } = await receiptDetails(assignment);
    if (!asset || !person?.email) {
      throw new ValidationError('This person has no email address to remind.', { assigneeId: ['No email address.'] });
    }

    const result = await sendEmail({
      template: 'returnReminder',
      to: person.email,
      payload: {
        personName: person.firstName,
        organisationName,
        assetName: asset.name,
        assetTag: asset.assetTag,
        dueDate: formatDate(assignment.dueAt),
        overdue: assignment.dueAt < new Date(),
      },
      dedupeKey: `return-reminder:${id}:${today()}`,
      relatedTo: { type: 'assignment', id },
    });
    assertSent(result.status);
    return { sent: 'return' };
  }

  throw new ValidationError('There is nothing to remind them about: receipt is confirmed and nothing is due back.', {
    id: ['Nothing to remind.'],
  });
}

function assertSent(status: 'queued' | 'duplicate' | 'suppressed'): void {
  if (status === 'duplicate') {
    throw new ValidationError('They were already reminded today.', { id: ['Already reminded today.'] });
  }
  if (status === 'suppressed') {
    throw new ValidationError('Email to this address is blocked after it bounced or was marked as spam.', {
      id: ['Address suppressed.'],
    });
  }
}

/**
 * Enters the organisation a receipt token belongs to.
 *
 * Read from the raw collection: there is no session and so no tenant yet, and
 * the token is what establishes one — the same way invitation links work.
 */
async function withReceiptTenant<T>(token: string, fn: (assignmentId: string) => Promise<T>): Promise<T> {
  const raw = await AssignmentModel.collection.findOne(
    { 'acknowledgement.tokenHash': hashToken(token) },
    { projection: { tenantId: 1 } },
  );
  if (!raw) throw new NotFoundError('Confirmation link');

  return runWithContext(
    { requestId: getContext()?.requestId ?? ulid(), tenantId: raw.tenantId as string, permissions: new Set(), actorType: 'system' },
    () => fn(String(raw._id)),
  );
}

export interface ReceiptPreview {
  organisationName: string;
  personName: string | null;
  assetName: string | null;
  assetTag: string | null;
  serialNumber: string | null;
  assignedAt: Date;
  confirmedAt: Date | null;
  /** False once the asset has been returned or handed to someone else. */
  stillAssigned: boolean;
}

export async function previewReceipt(token: string): Promise<ReceiptPreview> {
  return withReceiptTenant(token, async (id) => {
    const assignment = await AssignmentModel.findById(id).exec();
    if (!assignment) throw new NotFoundError('Confirmation link');
    const { asset, person, organisationName } = await receiptDetails(assignment);

    return {
      organisationName,
      personName: person ? `${person.firstName} ${person.lastName}` : null,
      assetName: asset?.name ?? null,
      assetTag: asset?.assetTag ?? null,
      serialNumber: asset?.serialNumber ?? null,
      assignedAt: assignment.assignedAt,
      confirmedAt: assignment.acknowledgement?.acknowledgedAt ?? null,
      stillAssigned: assignment.status === 'active',
    };
  });
}

/** Records the confirmation. Confirming twice is not an error — the answer is the same. */
export async function confirmReceipt(token: string): Promise<AssignmentDocument> {
  return withReceiptTenant(token, async (id) => {
    const found = await AssignmentModel.findById(id).exec();
    if (!found) throw new NotFoundError('Confirmation link');
    if (found.acknowledgement?.acknowledgedAt) return found;

    if (found.status !== 'active') {
      throw new ValidationError('This item is no longer recorded as yours, so there is nothing to confirm.', {
        token: ['No longer assigned.'],
      });
    }

    const asset = await AssetModel.findById(found.assetId).select('name').lean();

    const confirmed = await withTransaction(async (session) => {
      const doc = await AssignmentModel.findById(id).session(session).exec();
      if (!doc) throw new NotFoundError('Confirmation link');

      doc.acknowledgement!.acknowledgedAt = new Date();
      await doc.save({ session });

      await emit(
        {
          type: 'asset.acknowledged',
          // `doc`, not the transaction's result: this runs before that exists.
          subjectId: doc.assetId,
          subjectType: 'asset',
          summary: `Receipt of ${asset?.name ?? 'the asset'} was confirmed`,
          relatedIds: { assignmentId: String(doc._id), assigneeId: doc.assigneeId },
        },
        session,
      );

      return doc;
    });

    await flushOutbox();
    return confirmed;
  });
}
