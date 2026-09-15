import { DuplicateValueError, NotFoundError, ResourceInUseError } from '../../core/errors/index.js';
import { afterCursor, escapeRegExp, searchTokens, toPage } from '../../shared/cursor.js';
import { VendorModel, type VendorDocument } from './vendor.model.js';

export interface VendorInput {
  name?: string;
  kinds?: string[];
  website?: string;
  email?: string | null;
  phone?: string;
  contactName?: string;
  accountNumber?: string;
  address?: Record<string, string | undefined>;
  notes?: string;
  status?: 'active' | 'archived';
}

const tokensFor = (v: { name: string; contactName?: string | null; email?: string | null; accountNumber?: string | null }) =>
  searchTokens([v.name, v.contactName, v.email, v.accountNumber]);

export async function listVendors(options: { limit: number; cursor?: string; q?: string; status?: string; kind?: string }) {
  const filter: Record<string, unknown> = { ...afterCursor(options.cursor) };
  if (options.status) filter.status = options.status;
  if (options.kind) filter.kinds = options.kind;
  if (options.q) filter.searchTokens = new RegExp(`^${escapeRegExp(options.q.toLowerCase())}`);

  const rows = await VendorModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(options.limit + 1).exec();
  return toPage(rows, options.limit);
}

export async function findVendor(id: string): Promise<VendorDocument> {
  const vendor = await VendorModel.findById(id).exec();
  if (!vendor) throw new NotFoundError('Vendor');
  return vendor;
}

function translateDuplicate(err: unknown, name: string | undefined): never {
  if ((err as { code?: number }).code === 11000) throw new DuplicateValueError('name', name ?? '');
  throw err;
}

export async function createVendor(input: VendorInput): Promise<VendorDocument> {
  const vendor = new VendorModel({ ...input, email: input.email || null });
  vendor.searchTokens = tokensFor(vendor);
  try {
    return await vendor.save();
  } catch (err) {
    return translateDuplicate(err, input.name);
  }
}

export async function updateVendor(id: string, input: VendorInput): Promise<VendorDocument> {
  const vendor = await findVendor(id);
  const { address, ...rest } = input;
  vendor.set(rest);
  if (address) vendor.set('address', { ...(vendor.toObject().address ?? {}), ...address });
  if (input.email === '') vendor.email = null;
  vendor.searchTokens = tokensFor(vendor);
  try {
    return await vendor.save();
  } catch (err) {
    return translateDuplicate(err, input.name);
  }
}

/**
 * What else refuses a vendor's deletion.
 *
 * Assets, maintenance and licences point at vendors, and all three depend on
 * this module rather than the other way round — so they answer from above,
 * through the composition layer. Deleting the vendor behind forty invoices
 * would leave forty records bought from nobody.
 */
export type VendorDeleteGuard = (vendorId: string) => Promise<Array<{ type: string; count: number }>>;

const guards: VendorDeleteGuard[] = [];

export function addVendorDeleteGuard(guard: VendorDeleteGuard): void {
  guards.push(guard);
}

export async function deleteVendor(id: string): Promise<void> {
  const vendor = await findVendor(id);
  const references = (await Promise.all(guards.map((g) => g(id)))).flat().filter((r) => r.count > 0);
  if (references.length > 0) throw new ResourceInUseError('vendor', references);
  await vendor.softDelete();
}

export async function restoreVendor(id: string): Promise<VendorDocument> {
  const vendor = await VendorModel.findOne({ _id: id, deletedAt: { $ne: null } }).exec();
  if (!vendor) throw new NotFoundError('Vendor');
  try {
    return await vendor.restore();
  } catch (err) {
    return translateDuplicate(err, vendor.name);
  }
}

/** Names for a set of ids, for lists that show "bought from". One query, however many rows. */
export async function vendorNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await VendorModel.find({ _id: { $in: unique } }).setOptions({ withDeleted: true }).select('name').lean();
  return new Map(rows.map((r) => [String(r._id), r.name]));
}
