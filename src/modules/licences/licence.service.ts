import { getContext } from '../../core/context/index.js';
import { withTransaction } from '../../core/db/index.js';
import { encryptSecret, decryptSecret, maskSecret } from '../../core/crypto/index.js';
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { afterCursor, escapeRegExp, searchTokens, toPage } from '../../shared/cursor.js';
import { AssetModel } from '../assets/index.js';
import { PersonModel } from '../people/index.js';
import { findVendor } from '../vendors/index.js';
import { writeAuditRecord } from '../auditlog/index.js';
import { LicenceModel, LicenceSeatModel, type LicenceDocument, type LicenceSeatDocument } from './licence.model.js';

export interface LicenceInput {
  name?: string;
  vendorId?: string | null;
  type?: string;
  seats?: number | null;
  key?: string | null;
  purchasedAt?: string | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  autoRenew?: boolean;
  billingCycle?: string | null;
  cost?: { amountMinor: number | null; currency: string | null };
  orderRef?: string;
  notes?: string;
  status?: 'active' | 'cancelled';
}

const DATE_FIELDS = ['purchasedAt', 'startsAt', 'expiresAt'] as const;

export async function listLicences(options: {
  limit: number;
  cursor?: string;
  q?: string;
  vendorId?: string;
  status?: string;
  renewingWithinDays?: number;
}) {
  const filter: Record<string, unknown> = { ...afterCursor(options.cursor) };
  if (options.q) filter.searchTokens = new RegExp(`^${escapeRegExp(options.q.toLowerCase())}`);
  if (options.vendorId) filter.vendorId = options.vendorId;
  if (options.status) filter.status = options.status;
  if (options.renewingWithinDays) {
    filter.expiresAt = { $type: 'date', $lte: new Date(Date.now() + options.renewingWithinDays * 86_400_000) };
  }

  const rows = await LicenceModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(options.limit + 1).exec();
  return toPage(rows, options.limit);
}

export async function findLicence(id: string): Promise<LicenceDocument> {
  const licence = await LicenceModel.findById(id).exec();
  if (!licence) throw new NotFoundError('Licence');
  return licence;
}

async function assertVendor(vendorId: string | null | undefined): Promise<void> {
  if (!vendorId) return;
  try {
    await findVendor(vendorId);
  } catch {
    throw new ValidationError('That vendor does not exist.', { vendorId: ['Not found.'] });
  }
}

function apply(licence: LicenceDocument, input: LicenceInput): void {
  const { key, cost, ...rest } = input;

  for (const field of DATE_FIELDS) {
    if (rest[field] !== undefined) {
      licence.set(field, rest[field] ? new Date(rest[field]!) : null);
      delete rest[field];
    }
  }
  licence.set(rest);
  if (cost) licence.set('cost', cost);

  if (key !== undefined) {
    licence.set('keyEncrypted', key ? encryptSecret(key) : null);
    licence.keyHint = key ? maskSecret(key) : null;
  }

  licence.searchTokens = searchTokens([licence.name, licence.orderRef]);

  if (licence.startsAt && licence.expiresAt && licence.expiresAt < licence.startsAt) {
    throw new ValidationError('It cannot end before it starts.', { expiresAt: ['Before the start date.'] });
  }
}

export async function createLicence(input: LicenceInput): Promise<LicenceDocument> {
  await assertVendor(input.vendorId);
  const licence = new LicenceModel({});
  apply(licence, input);
  return licence.save();
}

export async function updateLicence(id: string, input: LicenceInput): Promise<LicenceDocument> {
  if (input.vendorId !== undefined) await assertVendor(input.vendorId);

  // Checked here for a helpful message, and again in the conditional write below:
  // an allocation can land between this read and the save.
  const licence = await findLicence(id);
  if (input.seats !== undefined && input.seats !== null && input.seats < licence.seatsUsed) {
    throw new ValidationError(
      `${licence.seatsUsed} seats are in use. Free ${licence.seatsUsed - input.seats} before reducing the total to ${input.seats}.`,
      { seats: [`At least ${licence.seatsUsed}.`] },
    );
  }

  apply(licence, input);
  const changes = licence.getChanges() as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
  if (!changes.$set && !changes.$unset) return licence;

  // Only the changed fields, and only while the seats in use still fit.
  const result = await LicenceModel.updateOne(
    input.seats != null ? { _id: id, seatsUsed: { $lte: input.seats } } : { _id: id },
    changes,
  ).exec();

  if (result.matchedCount === 0) {
    throw new ValidationError('More seats were allocated while you were editing. Check the count and try again.', {
      seats: ['Seats changed.'],
    });
  }
  return findLicence(id);
}

export async function deleteLicence(id: string): Promise<void> {
  const licence = await findLicence(id);
  if (licence.seatsUsed > 0) {
    throw new ValidationError(`${licence.seatsUsed} seats are still allocated. Free them first, or cancel the licence instead.`, {
      seats: ['Seats in use.'],
    });
  }
  await licence.softDelete();
}

/**
 * The licence key, decrypted — and a record that someone looked.
 *
 * Its own permission and its own audit entry: a key is a credential that can
 * be installed anywhere, and "who has seen our Adobe key?" deserves an answer.
 */
export async function revealKey(id: string): Promise<{ key: string | null }> {
  const licence = await LicenceModel.findById(id).select('+keyEncrypted name').exec();
  if (!licence) throw new NotFoundError('Licence');
  if (!licence.keyEncrypted) return { key: null };

  await writeAuditRecord({ action: 'licence.key_revealed', entityType: 'licence', entityId: id, metadata: { name: licence.name } });
  return { key: decryptSecret(licence.keyEncrypted) };
}

// ── Seats ───────────────────────────────────────────────────────────────────

async function assigneeName(type: string, id: string): Promise<string> {
  if (type === 'person') {
    const person = await PersonModel.findById(id).select('firstName lastName status').lean();
    if (!person) throw new ValidationError('That person does not exist.', { assigneeId: ['Not found.'] });
    if (person.status === 'inactive') {
      throw new ValidationError('That person has left. Give the seat to someone active.', { assigneeId: ['Not active.'] });
    }
    return `${person.firstName} ${person.lastName}`;
  }
  const asset = await AssetModel.findById(id).select('name').lean();
  if (!asset) throw new ValidationError('That asset does not exist.', { assigneeId: ['Not found.'] });
  return asset.name;
}

/**
 * Gives a seat to a person or a device.
 *
 * The seat count and the seat record move together in one transaction. The
 * increment only matches while a seat is free, so two admins allocating the
 * last seat at the same moment get one success and one clear refusal — never
 * eleven people on a ten-seat licence.
 */
export async function allocateSeat(
  licenceId: string,
  input: { assigneeType: 'person' | 'asset'; assigneeId: string; notes?: string },
): Promise<LicenceSeatDocument> {
  const licence = await findLicence(licenceId);
  if (licence.status !== 'active') {
    throw new ValidationError('This licence is cancelled. Reactivate it before giving out seats.', { status: ['Cancelled.'] });
  }
  const name = await assigneeName(input.assigneeType, input.assigneeId);

  try {
    return await withTransaction(async (session) => {
      const claimed = await LicenceModel.findOneAndUpdate(
        { _id: licenceId, $or: [{ seats: null }, { $expr: { $lt: ['$seatsUsed', '$seats'] } }] },
        { $inc: { seatsUsed: 1 } },
        { new: true, session },
      ).exec();

      if (!claimed) {
        throw new AppError(409, ErrorCode.RESOURCE_IN_USE, `All ${licence.seats} seats on ${licence.name} are in use. Free one, or add seats.`, {
          details: { seats: licence.seats },
        });
      }

      const [seat] = await LicenceSeatModel.create(
        [
          {
            licenceId,
            assigneeType: input.assigneeType,
            assigneeId: input.assigneeId,
            assignedBy: getContext()?.userId ?? null,
            notes: input.notes ?? '',
          },
        ],
        { session },
      );
      return seat!;
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(409, ErrorCode.DUPLICATE_VALUE, `${name} already has a seat on ${licence.name}.`, {
        fields: { assigneeId: ['Already has a seat.'] },
      });
    }
    throw err;
  }
}

export async function revokeSeat(licenceId: string, seatId: string): Promise<LicenceSeatDocument> {
  return withTransaction(async (session) => {
    const seat = await LicenceSeatModel.findOne({ _id: seatId, licenceId, revokedAt: null }).session(session).exec();
    if (!seat) throw new NotFoundError('Seat');

    seat.revokedAt = new Date();
    seat.revokedBy = getContext()?.userId ?? null;
    await seat.save({ session });
    await LicenceModel.updateOne({ _id: licenceId, seatsUsed: { $gt: 0 } }, { $inc: { seatsUsed: -1 } }, { session }).exec();
    return seat;
  });
}

/** Frees every seat someone holds — used when they leave. Returns how many. */
export async function revokeAllSeatsFor(assigneeId: string): Promise<number> {
  const seats = await LicenceSeatModel.find({ assigneeId, revokedAt: null }).select('_id licenceId').lean();
  for (const seat of seats) await revokeSeat(seat.licenceId, String(seat._id));
  return seats.length;
}

export async function seatsOn(licenceId: string, includeRevoked = false) {
  const filter: Record<string, unknown> = { licenceId };
  if (!includeRevoked) filter.revokedAt = null;
  const seats = await LicenceSeatModel.find(filter).sort({ revokedAt: 1, assignedAt: -1 }).limit(1000).lean();

  const people = seats.filter((s) => s.assigneeType === 'person').map((s) => s.assigneeId);
  const assets = seats.filter((s) => s.assigneeType === 'asset').map((s) => s.assigneeId);
  const [personRows, assetRows] = await Promise.all([
    PersonModel.find({ _id: { $in: people } }).setOptions({ withDeleted: true }).select('firstName lastName email').lean(),
    AssetModel.find({ _id: { $in: assets } }).setOptions({ withDeleted: true }).select('name assetTag').lean(),
  ]);
  const personName = new Map(personRows.map((p) => [String(p._id), { name: `${p.firstName} ${p.lastName}`, detail: p.email ?? '' }]));
  const assetName = new Map(assetRows.map((a) => [String(a._id), { name: a.name, detail: a.assetTag }]));

  return seats.map((s) => {
    const who = s.assigneeType === 'person' ? personName.get(s.assigneeId) : assetName.get(s.assigneeId);
    return {
      id: String(s._id),
      licenceId: s.licenceId,
      assigneeType: s.assigneeType,
      assigneeId: s.assigneeId,
      assigneeName: who?.name ?? null,
      assigneeDetail: who?.detail ?? null,
      assignedAt: s.assignedAt,
      revokedAt: s.revokedAt,
      notes: s.notes,
    };
  });
}

/** The software someone uses: their live seats, named. */
export async function seatsFor(assigneeId: string) {
  const seats = await LicenceSeatModel.find({ assigneeId, revokedAt: null }).sort({ assignedAt: -1 }).lean();
  const licences = await LicenceModel.find({ _id: { $in: seats.map((s) => s.licenceId) } })
    .select('name expiresAt status')
    .lean();
  const byId = new Map(licences.map((l) => [String(l._id), l]));

  return seats.map((s) => ({
    id: String(s._id),
    licenceId: s.licenceId,
    licenceName: byId.get(s.licenceId)?.name ?? null,
    licenceExpiresAt: byId.get(s.licenceId)?.expiresAt ?? null,
    assignedAt: s.assignedAt,
  }));
}
