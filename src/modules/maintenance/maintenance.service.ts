import type { ClientSession } from 'mongoose';
import { getContext } from '../../core/context/index.js';
import { withTransaction } from '../../core/db/index.js';
import { emit, flushOutbox, type EventType } from '../../core/events/index.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { afterCursor, toPage } from '../../shared/cursor.js';
import { AssetModel, findAsset, transitionAsset, updateAsset } from '../assets/index.js';
import { findVendor } from '../vendors/index.js';
import { MaintenanceModel, type MaintenanceDocument } from './maintenance.model.js';

/**
 * Scheduling, starting, finishing and cancelling maintenance.
 *
 * Every step writes the record and the asset's timeline entry in one
 * transaction. Moving the asset in and out of "Under maintenance" goes through
 * the lifecycle engine like any other state change, so a tenant's workflow
 * rules still apply — maintenance cannot become a side door around them.
 */

export interface MaintenanceInput {
  assetId?: string;
  vendorId?: string | null;
  type?: string;
  title?: string;
  description?: string;
  scheduledFor?: string | null;
  performedBy?: string;
  cost?: { amountMinor: number | null; currency: string | null };
  recurrenceMonths?: number | null;
  outcome?: string;
}

export async function listMaintenance(options: {
  limit: number;
  cursor?: string;
  assetId?: string;
  vendorId?: string;
  status?: string;
  overdue?: boolean;
}) {
  const filter: Record<string, unknown> = { ...afterCursor(options.cursor) };
  if (options.assetId) filter.assetId = options.assetId;
  if (options.vendorId) filter.vendorId = options.vendorId;
  if (options.status) filter.status = options.status;
  if (options.overdue) Object.assign(filter, overdueFilter());

  const rows = await MaintenanceModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(options.limit + 1).exec();
  return toPage(rows, options.limit);
}

/** Scheduled for a day that has passed and not started. */
export function overdueFilter(now = new Date()) {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { status: 'scheduled', scheduledFor: { $type: 'date', $lt: startOfToday } };
}

export async function findMaintenance(id: string): Promise<MaintenanceDocument> {
  const record = await MaintenanceModel.findById(id).exec();
  if (!record) throw new NotFoundError('Maintenance record');
  return record;
}

async function record(
  type: EventType,
  doc: MaintenanceDocument,
  summary: string,
  session: ClientSession,
): Promise<void> {
  await emit(
    {
      type,
      subjectId: doc.assetId,
      subjectType: 'asset',
      summary,
      relatedIds: { maintenanceId: String(doc._id), vendorId: doc.vendorId ?? null },
    },
    session,
  );
}

const TYPE_LABEL: Record<string, string> = {
  repair: 'Repair',
  service: 'Service',
  upgrade: 'Upgrade',
  inspection: 'Inspection',
  calibration: 'Calibration',
  other: 'Maintenance',
};

async function assertVendor(vendorId: string | null | undefined): Promise<void> {
  if (!vendorId) return;
  try {
    await findVendor(vendorId);
  } catch {
    throw new ValidationError('That vendor does not exist.', { vendorId: ['Not found.'] });
  }
}

/**
 * Moves the asset into maintenance, remembering where it came from.
 *
 * Returns null when it is already there — a second open record on an asset in
 * the workshop should not overwrite the state the first one remembered.
 */
async function moveIntoMaintenance(assetId: string, title: string): Promise<string | null> {
  const asset = await findAsset(assetId);
  if (asset.lifecycleState === 'maintenance') return null;
  await transitionAsset(assetId, 'maintenance', { comment: title });
  return asset.lifecycleState;
}

export async function createMaintenance(
  input: MaintenanceInput & { assetId: string; type: string; title: string; startNow?: boolean; moveAsset?: boolean },
): Promise<MaintenanceDocument> {
  const asset = await AssetModel.findById(input.assetId).select('name').lean();
  if (!asset) throw new ValidationError('That asset does not exist.', { assetId: ['Not found.'] });
  await assertVendor(input.vendorId);

  if (!input.startNow && !input.scheduledFor) {
    throw new ValidationError('Choose a date, or start the work now.', { scheduledFor: ['Choose a date.'] });
  }

  // Before anything is written: a workflow that refuses the move refuses the whole request.
  const stateBefore = input.startNow && input.moveAsset ? await moveIntoMaintenance(input.assetId, input.title) : null;

  const created = await withTransaction(async (session) => {
    const [doc] = await MaintenanceModel.create(
      [
        {
          assetId: input.assetId,
          vendorId: input.vendorId ?? null,
          type: input.type,
          title: input.title,
          description: input.description ?? '',
          status: input.startNow ? 'in_progress' : 'scheduled',
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
          startedAt: input.startNow ? new Date() : null,
          performedBy: input.performedBy ?? '',
          cost: input.cost ?? {},
          recurrenceMonths: input.recurrenceMonths ?? null,
          assetStateBefore: stateBefore,
          createdBy: getContext()?.userId ?? null,
        },
      ],
      { session },
    );

    await record(
      input.startNow ? 'asset.maintenance_started' : 'asset.maintenance_scheduled',
      doc!,
      input.startNow ? `${TYPE_LABEL[input.type]} started: ${input.title}` : `${TYPE_LABEL[input.type]} scheduled: ${input.title}`,
      session,
    );
    return doc!;
  });

  await flushOutbox();
  return created;
}

export async function updateMaintenance(id: string, input: MaintenanceInput): Promise<MaintenanceDocument> {
  const doc = await findMaintenance(id);
  if (doc.status === 'cancelled') {
    throw new ValidationError('This record was cancelled and can no longer be edited.', { status: ['Cancelled.'] });
  }
  if (input.vendorId !== undefined) await assertVendor(input.vendorId);

  const { scheduledFor, cost, ...rest } = input;
  delete (rest as { assetId?: string }).assetId;
  doc.set(rest);
  if (scheduledFor !== undefined) doc.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
  if (cost) doc.set('cost', cost);
  return doc.save();
}

export async function startMaintenance(id: string, options: { moveAsset?: boolean }): Promise<MaintenanceDocument> {
  const found = await findMaintenance(id);
  if (found.status !== 'scheduled') {
    throw new ValidationError('Only scheduled work can be started.', { status: [`Already ${found.status.replace('_', ' ')}.`] });
  }

  const stateBefore = options.moveAsset ? await moveIntoMaintenance(found.assetId, found.title) : null;

  const started = await withTransaction(async (session) => {
    const doc = await MaintenanceModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Maintenance record');
    doc.status = 'in_progress';
    doc.startedAt = new Date();
    doc.assetStateBefore = stateBefore;
    await doc.save({ session });
    await record('asset.maintenance_started', doc, `${TYPE_LABEL[doc.type]} started: ${doc.title}`, session);
    return doc;
  });

  await flushOutbox();
  return started;
}

export interface CompletionResult {
  record: MaintenanceDocument;
  next: MaintenanceDocument | null;
  /** Set when the work finished but the asset could not be moved back out of maintenance. */
  assetWarning: string | null;
}

/**
 * Finishes the work.
 *
 * The record is completed first and always; putting the asset back is second
 * and may be refused by the workflow (say, it was retired while in the shop).
 * That refusal comes back as a warning rather than undoing the completion —
 * the repair really did happen.
 */
export async function completeMaintenance(
  id: string,
  input: { completedAt?: string; outcome?: string; cost?: MaintenanceInput['cost']; performedBy?: string; condition?: string },
): Promise<CompletionResult> {
  const found = await findMaintenance(id);
  if (found.status === 'completed' || found.status === 'cancelled') {
    throw new ValidationError(`This work is already ${found.status}.`, { status: [found.status] });
  }

  const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
  if (completedAt.getTime() > Date.now() + 60_000) {
    throw new ValidationError('Work cannot be finished in the future.', { completedAt: ['In the future.'] });
  }

  const { completed, next } = await withTransaction(async (session) => {
    const doc = await MaintenanceModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Maintenance record');

    doc.status = 'completed';
    doc.startedAt = doc.startedAt ?? completedAt;
    doc.completedAt = completedAt;
    if (input.outcome !== undefined) doc.outcome = input.outcome;
    if (input.performedBy !== undefined) doc.performedBy = input.performedBy;
    if (input.cost) doc.set('cost', input.cost);

    let following: MaintenanceDocument | null = null;
    if (doc.recurrenceMonths && !doc.nextRecordId) {
      const due = new Date(completedAt);
      due.setUTCMonth(due.getUTCMonth() + doc.recurrenceMonths);
      const createdNext = (await MaintenanceModel.create(
        [
          {
            assetId: doc.assetId,
            vendorId: doc.vendorId,
            type: doc.type,
            title: doc.title,
            description: doc.description,
            status: 'scheduled',
            scheduledFor: due,
            performedBy: doc.performedBy,
            recurrenceMonths: doc.recurrenceMonths,
            previousRecordId: String(doc._id),
            createdBy: getContext()?.userId ?? null,
          },
        ],
        { session },
      )) as unknown as MaintenanceDocument[];
      following = createdNext[0]!;
      doc.nextRecordId = String(following!._id);
      await record('asset.maintenance_scheduled', following!, `${TYPE_LABEL[doc.type]} scheduled: ${doc.title}`, session);
    }

    await doc.save({ session });
    await record('asset.maintenance_completed', doc, `${TYPE_LABEL[doc.type]} completed: ${doc.title}`, session);
    return { completed: doc, next: following };
  });

  await flushOutbox();

  let assetWarning: string | null = null;
  const asset = await findAsset(completed.assetId);

  if (completed.assetStateBefore && asset.lifecycleState === 'maintenance') {
    const others = await MaintenanceModel.countDocuments({
      assetId: completed.assetId,
      status: 'in_progress',
      _id: { $ne: completed._id },
    });

    // Another job is still open on it: the asset stays in the workshop.
    if (others === 0) {
      const preferred = asset.currentAssignment ? 'deployed' : 'in_stock';
      try {
        await transitionAsset(completed.assetId, preferred, { comment: `${completed.title} completed` });
      } catch (err) {
        assetWarning =
          err instanceof AppError
            ? `The work is recorded, but the asset is still under maintenance: ${err.message}`
            : 'The work is recorded, but the asset could not be moved out of maintenance.';
      }
    }
  }

  if (input.condition) {
    await updateAsset(completed.assetId, { condition: input.condition } as never);
  }

  return { record: completed, next, assetWarning };
}

export async function cancelMaintenance(id: string): Promise<MaintenanceDocument> {
  const found = await findMaintenance(id);
  if (found.status === 'completed' || found.status === 'cancelled') {
    throw new ValidationError(`This work is already ${found.status}.`, { status: [found.status] });
  }

  const cancelled = await withTransaction(async (session) => {
    const doc = await MaintenanceModel.findById(id).session(session).exec();
    if (!doc) throw new NotFoundError('Maintenance record');
    doc.status = 'cancelled';
    doc.cancelledAt = new Date();
    await doc.save({ session });
    await record('asset.maintenance_cancelled', doc, `${TYPE_LABEL[doc.type]} cancelled: ${doc.title}`, session);
    return doc;
  });

  await flushOutbox();
  return cancelled;
}

export async function deleteMaintenance(id: string): Promise<void> {
  const doc = await findMaintenance(id);
  if (doc.status === 'in_progress') {
    throw new ValidationError('Finish or cancel this work before deleting it.', { status: ['In progress.'] });
  }
  await doc.softDelete();
}

/** Money spent on an asset's upkeep, by currency. Mixed currencies are never added together. */
export async function maintenanceCosts(filter: { assetId?: string; vendorId?: string }) {
  // Unfiltered, this would total every repair in the organisation — not what either caller means.
  if (!filter.assetId && !filter.vendorId) {
    throw new ValidationError('Filter by an asset or a vendor.', { assetId: ['Required without vendorId.'] });
  }
  const match: Record<string, unknown> = { status: 'completed', 'cost.amountMinor': { $type: 'number' } };
  if (filter.assetId) match.assetId = filter.assetId;
  if (filter.vendorId) match.vendorId = filter.vendorId;

  const rows = await MaintenanceModel.aggregate<{ _id: string; total: number; count: number }>([
    { $match: match },
    { $group: { _id: '$cost.currency', total: { $sum: '$cost.amountMinor' }, count: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ currency: r._id, amountMinor: r.total, records: r.count }));
}
