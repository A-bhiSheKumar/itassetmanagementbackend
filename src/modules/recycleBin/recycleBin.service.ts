import type { Model } from 'mongoose';
import { AssetModel, restoreAsset } from '../assets/index.js';
import { PersonModel, ORG_UNIT_MODELS, restorePerson, restoreOrgUnit } from '../people/index.js';
import { DocumentModel, restoreDocument, purgeDeletedDocuments } from '../documents/index.js';
import { userDirectory } from '../memberships/index.js';
import { writeAuditRecord } from '../auditlog/index.js';
import { VendorModel, restoreVendor } from '../vendors/index.js';
import { LicenceModel } from '../licences/index.js';
import { AppError, ErrorCode, NotFoundError } from '../../core/errors/index.js';

/**
 * The recycle bin: everything deleted in the last day, and the way back.
 *
 * Deleting stays a single click everywhere in the product — no "are you sure?"
 * on routine records — because this is the safety net. After the window a
 * scheduled purge removes the records for good; the audit log keeps the fact
 * that they existed and who deleted them.
 */

export const RECYCLE_WINDOW_MS = 24 * 60 * 60_000;

export const BIN_TYPES = ['asset', 'person', 'location', 'department', 'document', 'vendor', 'licence'] as const;
export type BinType = (typeof BIN_TYPES)[number];

/** Who may see and restore each kind — the same permission that allowed deleting it. */
export const BIN_PERMISSION: Record<BinType, string> = {
  asset: 'asset:delete',
  person: 'person:deactivate',
  location: 'settings:manage',
  department: 'settings:manage',
  document: 'asset:update',
  vendor: 'vendor:manage',
  licence: 'licence:manage',
};

export interface BinItem {
  type: BinType;
  id: string;
  name: string;
  detail: string;
  deletedAt: Date;
  deletedBy: string | null;
  deletedByName: string | null;
  restorableUntil: Date;
}

type Row = { _id: unknown; deletedAt: Date; deletedBy: string | null } & Record<string, unknown>;

const cutoff = () => new Date(Date.now() - RECYCLE_WINDOW_MS);
const PER_TYPE = 200;

async function deleted(model: Model<unknown>, select: string, extra: Record<string, unknown> = {}): Promise<Row[]> {
  return model
    .find({ deletedAt: { $gte: cutoff() }, ...extra })
    .sort({ deletedAt: -1 })
    .limit(PER_TYPE)
    .select(`${select} deletedAt deletedBy`)
    .lean<Row[]>();
}

const LOADERS: Record<BinType, () => Promise<Array<Omit<BinItem, 'deletedByName' | 'restorableUntil'>>>> = {
  async asset() {
    const rows = await deleted(AssetModel as never, 'name assetTag serialNumber');
    return rows.map((r) => ({
      type: 'asset',
      id: String(r._id),
      name: String(r.name),
      detail: [r.assetTag, r.serialNumber].filter(Boolean).join(' · '),
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
    }));
  },
  async person() {
    const rows = await deleted(PersonModel as never, 'firstName lastName email jobTitle');
    return rows.map((r) => ({
      type: 'person',
      id: String(r._id),
      name: `${String(r.firstName)} ${String(r.lastName)}`,
      detail: [r.jobTitle, r.email].filter(Boolean).join(' · '),
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
    }));
  },
  async location() {
    const rows = await deleted(ORG_UNIT_MODELS.location as never, 'name code');
    return rows.map((r) => ({ type: 'location', id: String(r._id), name: String(r.name), detail: String(r.code ?? ''), deletedAt: r.deletedAt, deletedBy: r.deletedBy }));
  },
  async department() {
    const rows = await deleted(ORG_UNIT_MODELS.department as never, 'name code');
    return rows.map((r) => ({ type: 'department', id: String(r._id), name: String(r.name), detail: String(r.code ?? ''), deletedAt: r.deletedAt, deletedBy: r.deletedBy }));
  },
  async vendor() {
    const rows = await deleted(VendorModel as never, 'name contactName');
    return rows.map((r) => ({ type: 'vendor', id: String(r._id), name: String(r.name), detail: String(r.contactName ?? ''), deletedAt: r.deletedAt, deletedBy: r.deletedBy }));
  },
  async licence() {
    const rows = await deleted(LicenceModel as never, 'name type');
    return rows.map((r) => ({ type: 'licence', id: String(r._id), name: String(r.name), detail: String(r.type), deletedAt: r.deletedAt, deletedBy: r.deletedBy }));
  },
  async document() {
    // Abandoned uploads are soft-deleted by the storage sweep, not by a person,
    // and were never files anyone could see. They are not in the bin.
    const rows = await deleted(DocumentModel as never, 'fileName entityType', { status: 'ready' });
    return rows.map((r) => ({
      type: 'document',
      id: String(r._id),
      name: String(r.fileName),
      detail: `Attached to ${r.entityType === 'person' ? 'a person' : `an ${String(r.entityType)}`}`,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
    }));
  },
};

/** Everything restorable that this caller is allowed to restore, newest first. */
export async function listBin(permissions: ReadonlySet<string>): Promise<BinItem[]> {
  const types = BIN_TYPES.filter((t) => permissions.has(BIN_PERMISSION[t]));
  const rows = (await Promise.all(types.map((t) => LOADERS[t]()))).flat();

  const names = await userDirectory().namesFor(rows.map((r) => r.deletedBy).filter((id): id is string => Boolean(id)));

  return rows
    .map((r) => ({
      ...r,
      deletedByName: r.deletedBy ? (names.get(r.deletedBy)?.name ?? null) : null,
      restorableUntil: new Date(r.deletedAt.getTime() + RECYCLE_WINDOW_MS),
    }))
    .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}

const MODELS: Record<BinType, Model<unknown>> = {
  asset: AssetModel as never,
  person: PersonModel as never,
  location: ORG_UNIT_MODELS.location as never,
  department: ORG_UNIT_MODELS.department as never,
  document: DocumentModel as never,
  vendor: VendorModel as never,
  licence: LicenceModel as never,
};

/**
 * Restores one item, if it is still inside the window.
 *
 * Past the window the purge may already have run, and restoring something the
 * bin no longer shows would be a surprise in both directions — so it is refused
 * the same way whether or not the row happens to survive.
 */
export async function restoreItem(type: BinType, id: string): Promise<{ type: BinType; id: string }> {
  const row = await MODELS[type].findOne({ _id: id, deletedAt: { $ne: null } }).select('deletedAt').lean<{ deletedAt: Date }>();
  if (!row) throw new NotFoundError('Deleted item');

  if (row.deletedAt < cutoff()) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'This was deleted more than a day ago and can no longer be restored.');
  }

  if (type === 'asset') await restoreAsset(id);
  else if (type === 'person') await restorePerson(id);
  else if (type === 'location' || type === 'department') await restoreOrgUnit(type, id);
  else if (type === 'vendor') await restoreVendor(id);
  else if (type === 'licence') await (await LicenceModel.findOne({ _id: id, deletedAt: { $ne: null } }).exec())!.restore();
  else await restoreDocument(id);

  return { type, id };
}

/**
 * Permanently removes what has been in the bin longer than the window.
 *
 * Runs per tenant, under that tenant's context. Assignment records are kept:
 * they are the custody history, and they already render a removed holder or
 * asset honestly.
 */
export async function purgeExpired(): Promise<Record<BinType, number>> {
  const before = cutoff();
  const filter = { deletedAt: { $lt: before } };

  const [asset, person, location, department, vendor, licence] = await Promise.all([
    AssetModel.deleteMany(filter),
    PersonModel.deleteMany(filter),
    ORG_UNIT_MODELS.location.deleteMany(filter as never),
    ORG_UNIT_MODELS.department.deleteMany(filter as never),
    VendorModel.deleteMany(filter),
    LicenceModel.deleteMany(filter),
  ]);
  const document = await purgeDeletedDocuments(before);

  const counts = {
    asset: asset.deletedCount,
    person: person.deletedCount,
    location: location.deletedCount,
    department: department.deletedCount,
    document,
    vendor: vendor.deletedCount,
    licence: licence.deletedCount,
  };

  if (Object.values(counts).some((n) => n > 0)) {
    await writeAuditRecord({ action: 'recycle_bin.purged', entityType: 'tenant', metadata: { counts, deletedBefore: before } });
  }

  return counts;
}
